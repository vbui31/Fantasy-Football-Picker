const POSITION_DEPTH = { QB: 1.15, RB: 3.2, WR: 3.5, TE: 1.25, K: 1, DST: 1 };

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round1 = (value) => Math.round(value * 10) / 10;

export function replacementRanks(teamCount, rounds = 15) {
  const benchFactor = clamp((rounds - 10) / 5, 0.35, 1.4);
  const depth = {
    QB: 1 + .15 * benchFactor,
    RB: 2.6 + .6 * benchFactor,
    WR: 2.8 + .7 * benchFactor,
    TE: 1 + .25 * benchFactor,
    K: POSITION_DEPTH.K,
    DST: POSITION_DEPTH.DST
  };
  return Object.fromEntries(Object.entries(depth).map(([position, multiplier]) => [position, Math.max(1, Math.round(teamCount * multiplier))]));
}

function softTiers(players, maximumTiers = 9) {
  if (!players.length) return;
  if (players.length === 1) {
    Object.assign(players[0], { tier: 1, tierProbability: 1, tierDropoff: 0 });
    return;
  }

  const values = players.map((player) => player.projection);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
  const tierCount = clamp(Math.round(Math.sqrt(players.length / 2)), 3, Math.min(maximumTiers, players.length));
  let centers = Array.from({ length: tierCount }, (_, index) => {
    const quantileIndex = Math.round(index * (values.length - 1) / Math.max(1, tierCount - 1));
    return values[quantileIndex];
  });
  const spread = Math.max(.75, deviation / Math.max(2, tierCount * .7));

  for (let iteration = 0; iteration < 24; iteration++) {
    const weighted = centers.map(() => ({ total: 0, weight: 0 }));
    for (const value of values) {
      const weights = centers.map((center) => Math.exp(-((value - center) ** 2) / (2 * spread ** 2)) + 1e-9);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      weights.forEach((weight, index) => {
        const probability = weight / total;
        weighted[index].total += value * probability;
        weighted[index].weight += probability;
      });
    }
    centers = centers.map((center, index) => weighted[index].weight ? weighted[index].total / weighted[index].weight : center);
  }

  const ordered = centers.map((center, index) => ({ center, index })).sort((a, b) => b.center - a.center);
  const tierByComponent = new Map(ordered.map((entry, index) => [entry.index, index + 1]));
  const tierPlayers = new Map();

  for (const player of players) {
    const weights = centers.map((center) => Math.exp(-((player.projection - center) ** 2) / (2 * spread ** 2)) + 1e-9);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const probabilities = weights.map((weight) => weight / total);
    const component = probabilities.indexOf(Math.max(...probabilities));
    player.tier = tierByComponent.get(component);
    player.tierProbability = probabilities[component];
    if (!tierPlayers.has(player.tier)) tierPlayers.set(player.tier, []);
    tierPlayers.get(player.tier).push(player);
  }

  for (const [tier, members] of tierPlayers) {
    const nextTier = tierPlayers.get(tier + 1) || [];
    const currentFloor = Math.min(...members.map((player) => player.projection));
    const nextCeiling = nextTier.length ? Math.max(...nextTier.map((player) => player.projection)) : currentFloor;
    const dropoff = round1(Math.max(0, currentFloor - nextCeiling));
    members.forEach((player) => { player.tierDropoff = dropoff; });
  }
}

export function enrichPlayerModel(players, { teams = 10, rounds = 15 } = {}) {
  const ranks = replacementRanks(teams, rounds);
  for (const position of Object.keys(ranks)) {
    const positionPlayers = players
      .filter((player) => player.position === position && Number.isFinite(player.projection))
      .sort((a, b) => b.projection - a.projection || a.sourceRank - b.sourceRank);
    if (!positionPlayers.length) continue;
    const baselineRank = Math.min(positionPlayers.length, ranks[position]);
    const replacement = positionPlayers[baselineRank - 1].projection;
    positionPlayers.forEach((player) => {
      player.replacementRank = baselineRank;
      player.replacementProjection = replacement;
      player.vbd = round1(player.projection - replacement);
    });
    const modeledCount = Math.min(positionPlayers.length, Math.max(baselineRank + teams, teams * 2));
    softTiers(positionPlayers.slice(0, modeledCount));
    positionPlayers.slice(modeledCount).forEach((player, index) => {
      player.tier = 10 + Math.floor(index / Math.max(1, teams));
      player.tierProbability = .5;
      player.tierDropoff = 0;
    });
  }
  return ranks;
}

export function nextPickIndexForTeam(pickIndex, team, teams, totalPicks) {
  for (let index = pickIndex + 1; index < totalPicks; index++) {
    const round = Math.floor(index / teams);
    const offset = index % teams;
    const pickingTeam = round % 2 === 0 ? offset : teams - 1 - offset;
    if (pickingTeam === team) return index;
  }
  return null;
}

function logistic(value) { return 1 / (1 + Math.exp(-value)); }

export function availabilityAtNextPick(player, currentPickIndex, nextPickIndex) {
  if (nextPickIndex === null || nextPickIndex <= currentPickIndex) return 1;
  const marketPick = Number.isFinite(player.adp) ? player.adp : Number.isFinite(player.expertRank) ? player.expertRank : Number.isFinite(player.sourceRank) ? player.sourceRank : player.rank;
  const spread = Number.isFinite(player.adpDeviation) ? Math.max(4, player.adpDeviation) : Math.max(5, Math.min(22, 4 + marketPick * .11));
  const draftedByCurrent = logistic(((currentPickIndex + 1) - marketPick) / spread);
  const draftedByNext = logistic(((nextPickIndex + 1) - marketPick) / spread);
  const survival = (1 - draftedByNext) / Math.max(.02, 1 - draftedByCurrent);
  return clamp(survival, 0, 1);
}

function uncertaintyRatio(player) {
  if (Number.isFinite(player.uncertainty)) return clamp(player.uncertainty <= 1 ? player.uncertainty : player.uncertainty / 100, 0, 1);
  if (Number.isFinite(player.standardDeviation) && player.projection > 0) return clamp(player.standardDeviation / player.projection, 0, 1);
  if (Number.isFinite(player.floor) && Number.isFinite(player.ceiling) && player.projection > 0) return clamp((player.ceiling - player.floor) / (2 * player.projection), 0, 1);
  return .22;
}

export function evidenceProfile(player, round = 0, totalRounds = 15) {
  const uncertainty = uncertaintyRatio(player);
  const rookie = player.yearsExperience === 0;
  const consensus = player.modelSource === "ffanalytics";
  const reliability = clamp(.83 - uncertainty * .85 - (player.injury ? .15 : 0) - (rookie ? .1 : 0) + (consensus ? .04 : 0), .1, .95);
  const estimatedSpread = player.projection * uncertainty;
  const floor = Number.isFinite(player.floor) ? player.floor : player.projection - estimatedSpread;
  const ceiling = Number.isFinite(player.ceiling) ? player.ceiling : player.projection + estimatedSpread;
  const progress = clamp((round + 1) / Math.max(1, totalRounds), 0, 1);
  const phase = progress <= .4 ? "Foundation" : progress <= .72 ? "Balance" : "Upside";
  const weights = phase === "Foundation"
    ? { floor: .42, mean: .53, ceiling: .05 }
    : phase === "Balance"
      ? { floor: .2, mean: .6, ceiling: .2 }
      : { floor: .08, mean: .47, ceiling: .45 };
  const utilityProjection = floor * weights.floor + player.projection * weights.mean + ceiling * weights.ceiling;
  const reliabilityWeight = phase === "Foundation" ? 18 : phase === "Balance" ? 10 : 4;
  const impact = (utilityProjection - player.projection) * .12 + (reliability - .5) * reliabilityWeight;
  return { uncertainty, reliability, floor, ceiling, phase, utilityProjection, impact, rookie };
}

const REQUIRED_STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 };

export function missingStarterSlots(counts) {
  const missingBase = Object.entries(REQUIRED_STARTERS).reduce((total, [position, required]) => total + Math.max(0, required - (counts[position] || 0)), 0);
  const baseSkillFilled = Math.min(counts.RB || 0, 2) + Math.min(counts.WR || 0, 2) + Math.min(counts.TE || 0, 1);
  const extraSkill = Math.max(0, (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0) - baseSkillFilled);
  return missingBase + Math.max(0, 2 - extraSkill);
}

function constraintFit(player, counts, rosterSize, totalRounds) {
  const before = missingStarterSlots(counts);
  const afterCounts = { ...counts, [player.position]: (counts[player.position] || 0) + 1 };
  const after = missingStarterSlots(afterCounts);
  const picksAfterThis = Math.max(0, totalRounds - rosterSize - 1);
  if (after > picksAfterThis) return { impact: -1000, detail: "This pick would make a complete legal starting lineup impossible." };
  if (before > after && after === picksAfterThis) return { impact: 48, detail: "Roster math requires this position now to preserve a legal lineup." };
  if (before > after && before >= picksAfterThis) return { impact: 20, detail: "Closes a required starter slot before the remaining picks become constrained." };
  return { impact: 0, detail: "The roster remains feasible after this selection." };
}

function rosterFit(player, counts, round, profile) {
  let impact = 0;
  let detail = "Adds depth without creating a roster imbalance.";
  if (player.position === "RB") {
    impact = (counts.RB || 0) < 2 ? 28 : (counts.RB || 0) < Math.round(profile.targetRoster.RB) ? 8 : -5;
    detail = (counts.RB || 0) < 2 ? "Fills a starting RB slot." : "Builds RB depth toward the league profile.";
  }
  if (player.position === "WR") {
    impact = (counts.WR || 0) < 2 ? 27 : (counts.WR || 0) < Math.round(profile.targetRoster.WR) ? 9 : -5;
    detail = (counts.WR || 0) < 2 ? "Fills a starting WR slot." : "Builds WR depth toward the league profile.";
  }
  if (player.position === "QB") {
    impact = !(counts.QB) ? (round >= profile.medianFirstRound.QB - 2 ? 24 : 5) : round >= 12 && counts.QB < 2 ? 4 : -34;
    detail = !(counts.QB) ? "Covers the open starting QB slot." : "A second QB is a lower-priority use of this pick.";
  }
  if (player.position === "TE") {
    impact = !(counts.TE) ? (round >= profile.medianFirstRound.TE - 2 ? 20 : 7) : round >= 12 && counts.TE < 2 ? 3 : -22;
    detail = !(counts.TE) ? "Covers the open starting TE slot." : "A second TE is a lower-priority use of this pick.";
  }
  if (player.position === "K") {
    impact = round >= profile.medianFirstRound.K - 1 && !(counts.K) ? 26 : -72;
    detail = "Kicker value is intentionally delayed until the final rounds.";
  }
  if (player.position === "DST") {
    impact = round >= profile.medianFirstRound.DST - 1 && !(counts.DST) ? 25 : -66;
    detail = "Defense value is intentionally delayed until the final rounds.";
  }
  return { impact, detail };
}

export function scoreCandidate(player, { roster, round, currentPickIndex, nextPickIndex, availablePlayers, profile, totalRounds = 15 }) {
  const counts = roster.reduce((result, rosterPlayer) => {
    result[rosterPlayer.position] = (result[rosterPlayer.position] || 0) + 1;
    return result;
  }, {});
  const fit = rosterFit(player, counts, round, profile);
  const constraint = constraintFit(player, counts, roster.length, totalRounds);
  const evidence = evidenceProfile(player, round, totalRounds);
  const availability = availabilityAtNextPick(player, currentPickIndex, nextPickIndex);
  const tierRemaining = availablePlayers.filter((candidate) => candidate.position === player.position && candidate.tier === player.tier).length;
  const tierImpact = Math.min(16, (player.tierDropoff || 0) * .8) + (tierRemaining <= 2 ? 5 : 0);
  const hasNextPick = nextPickIndex !== null && nextPickIndex > currentPickIndex;
  const urgencyImpact = hasNextPick ? (1 - availability) * Math.min(30, 10 + Math.max(0, player.vbd) * .12) : 0;
  const riskImpact = (player.injury ? -8 : 0);
  const marketPick = Number.isFinite(player.adp) ? player.adp : Number.isFinite(player.expertRank) ? player.expertRank : player.sourceRank;
  const reach = Number.isFinite(marketPick) ? marketPick - (currentPickIndex + 1) : 0;
  const marketImpact = reach > 14 ? -Math.min(14, (reach - 14) * .16) : reach < 2 ? 3 : 0;
  const score = player.vbd + fit.impact + constraint.impact + evidence.impact + tierImpact + urgencyImpact + riskImpact + marketImpact;
  const factors = [
    { label: "Value", impact: player.vbd, detail: `${player.vbd >= 0 ? "+" : ""}${player.vbd.toFixed(1)} points versus ${player.position}${player.replacementRank}.` },
    { label: "Roster fit", impact: fit.impact, detail: fit.detail },
    { label: `${evidence.phase} utility`, impact: evidence.impact, detail: `${Math.round(evidence.reliability * 100)}% evidence reliability${evidence.rookie ? " after a rookie cold-start adjustment" : ""}; this phase weights ${evidence.phase === "Foundation" ? "floor" : evidence.phase === "Upside" ? "ceiling" : "balanced outcomes"}.` },
    { label: "Tier", impact: tierImpact, detail: `${tierRemaining} player${tierRemaining === 1 ? "" : "s"} left in Tier ${player.tier}; next tier drops ${round1(player.tierDropoff || 0).toFixed(1)} points.` },
    { label: "Wait risk", impact: urgencyImpact, detail: hasNextPick ? `${Math.round(availability * 100)}% estimated chance to reach the next pick.` : "Final selection; there is no later turn to preserve value for." }
  ];
  if (constraint.impact) factors.push({ label: "Lineup constraint", impact: constraint.impact, detail: constraint.detail });
  if (riskImpact) factors.push({ label: "Availability", impact: riskImpact, detail: `${player.injury} designation reduces the score.` });
  if (marketImpact < 0) factors.push({ label: "Reach", impact: marketImpact, detail: "Market position suggests a later selection may be possible." });
  return { score, availability, hasNextPick, tierRemaining, reliability: evidence.reliability, phase: evidence.phase, utilityProjection: evidence.utilityProjection, factors: factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)) };
}
