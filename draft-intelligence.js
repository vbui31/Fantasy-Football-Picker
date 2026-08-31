import { OPPONENT_STRATEGIES } from "./draft-model.js";

export const PPR_SCORING = Object.freeze({ id: "ppr", reception: 1, passYards: .04, passTd: 4, rushYards: .1, receivingYards: .1, rushTd: 6, receivingTd: 6 });
export const DEFAULT_ROSTER_SLOTS = Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, SUPERFLEX: 0, K: 1, DST: 1, BENCH: 5 });

export function normalizeLeagueSettings(settings = {}) {
  const slots = { ...DEFAULT_ROSTER_SLOTS, ...(settings.rosterSlots || {}) };
  for (const key of Object.keys(slots)) slots[key] = Math.max(0, Math.round(Number(slots[key]) || 0));
  const starterCount = Object.entries(slots).filter(([key]) => key !== "BENCH").reduce((sum, [, value]) => sum + value, 0);
  const rounds = Math.max(starterCount, Number(settings.rounds) || starterCount + slots.BENCH);
  slots.BENCH = Math.max(0, rounds - starterCount);
  return {
    ...settings,
    teams: Math.max(4, Number(settings.teams) || 10),
    rounds,
    scoring: { ...PPR_SCORING, ...(settings.scoring || {}), id: "ppr", reception: 1 },
    rosterSlots: slots,
    superflex: slots.SUPERFLEX > 0,
    tePremium: Math.max(0, Number(settings.tePremium) || 0),
    draftFormat: settings.draftFormat === "auction" ? "auction" : "snake",
    auctionBudget: Math.max(50, Number(settings.auctionBudget) || 200),
    preset: settings.preset || "balanced"
  };
}

export function seededRandom(seed = Date.now()) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function createOpponentBeliefs(teams, userSlot) {
  return Object.fromEntries(Array.from({ length: teams }, (_, team) => [team, {
    probabilities: Object.fromEntries(OPPONENT_STRATEGIES.map((strategy) => [strategy.id, 1 / OPPONENT_STRATEGIES.length])),
    observedPicks: 0,
    reachAverage: 0,
    runFollowRate: 0,
    needIgnoreRate: 0,
    isUser: team === userSlot
  }]));
}

const strategySignal = (strategyId, player, roster, round) => {
  const counts = roster.reduce((result, item) => ({ ...result, [item.position]: (result[item.position] || 0) + 1 }), {});
  if (strategyId === "hero-rb") return player.position === "RB" && !(counts.RB) && round < 3 ? 2.2 : player.position === "WR" && counts.RB ? .8 : 0;
  if (strategyId === "wr-core") return player.position === "WR" && round < 6 ? 1.8 : player.position === "RB" && round >= 4 ? .7 : 0;
  if (strategyId === "robust-rb") return player.position === "RB" && (counts.RB || 0) < 2 && round < 5 ? 2 : 0;
  if (strategyId === "elite-te") return player.position === "TE" && player.tier === 1 && !(counts.TE) && round < 5 ? 2.3 : 0;
  if (strategyId === "late-qb") return player.position === "QB" && round < 8 ? -2 : ["RB", "WR"].includes(player.position) ? .6 : 0;
  return Math.max(-1, Math.min(1, (player.vbd || 0) / 75));
};

export function updateOpponentBelief(current, { player, rosterBefore = [], round = 0, pickNumber = 1, recentPicks = [] }) {
  const prior = current || createOpponentBeliefs(1, -1)[0];
  const likelihoods = Object.fromEntries(OPPONENT_STRATEGIES.map((strategy) => [strategy.id, Math.exp(strategySignal(strategy.id, player, rosterBefore, round))]));
  const unnormalized = Object.fromEntries(OPPONENT_STRATEGIES.map((strategy) => [strategy.id, Math.max(.001, prior.probabilities[strategy.id] || 0) * likelihoods[strategy.id]]));
  const total = Object.values(unnormalized).reduce((sum, value) => sum + value, 0);
  const probabilities = Object.fromEntries(Object.entries(unnormalized).map(([key, value]) => [key, value / total]));
  const observedPicks = (prior.observedPicks || 0) + 1;
  const reach = Number.isFinite(player.adp) ? Math.max(0, player.adp - pickNumber) : 0;
  const followedRun = recentPicks.filter((item) => item?.position === player.position).length >= 2 ? 1 : 0;
  const counts = rosterBefore.reduce((result, item) => ({ ...result, [item.position]: (result[item.position] || 0) + 1 }), {});
  const ignoredNeed = round >= 6 && ((counts.QB || 0) === 0 || (counts.TE || 0) === 0) && !["QB", "TE"].includes(player.position) ? 1 : 0;
  return {
    ...prior,
    probabilities,
    observedPicks,
    reachAverage: ((prior.reachAverage || 0) * (observedPicks - 1) + reach) / observedPicks,
    runFollowRate: ((prior.runFollowRate || 0) * (observedPicks - 1) + followedRun) / observedPicks,
    needIgnoreRate: ((prior.needIgnoreRate || 0) * (observedPicks - 1) + ignoredNeed) / observedPicks
  };
}

export function dominantOpponentStyle(belief) {
  if (!belief?.probabilities) return { id: "adaptive", name: "Adaptive Value", confidence: 0 };
  const [id, confidence] = Object.entries(belief.probabilities).sort((a, b) => b[1] - a[1])[0];
  return { ...(OPPONENT_STRATEGIES.find((strategy) => strategy.id === id) || OPPONENT_STRATEGIES[0]), confidence };
}

function takeBest(pool, positions) {
  let bestIndex = -1;
  let bestProjection = -Infinity;
  for (let index = 0; index < pool.length; index++) {
    if (!positions.includes(pool[index].position)) continue;
    if ((pool[index].projection || 0) > bestProjection) { bestProjection = pool[index].projection || 0; bestIndex = index; }
  }
  return bestIndex < 0 ? null : pool.splice(bestIndex, 1)[0];
}

export function optimizePprLineup(roster, rawSettings) {
  const settings = normalizeLeagueSettings(rawSettings);
  const remaining = [...roster];
  const starters = [];
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    for (let count = 0; count < settings.rosterSlots[position]; count++) {
      const player = takeBest(remaining, [position]);
      if (player) starters.push(player);
    }
  }
  for (let count = 0; count < settings.rosterSlots.FLEX; count++) {
    const player = takeBest(remaining, ["RB", "WR", "TE"]);
    if (player) starters.push(player);
  }
  for (let count = 0; count < settings.rosterSlots.SUPERFLEX; count++) {
    const player = takeBest(remaining, ["QB", "RB", "WR", "TE"]);
    if (player) starters.push(player);
  }
  return { starters, bench: remaining };
}

const injuryWeight = (player) => {
  const value = `${player.injury || ""} ${player.liveStatus || ""}`.toLowerCase();
  if (/out|injured reserve|suspended/.test(value)) return 1;
  if (/doubtful/.test(value)) return .7;
  if (/questionable|dnr/.test(value)) return .35;
  return 0;
};

export function evaluateRoster(roster, rawSettings, leagueRosters = []) {
  const settings = normalizeLeagueSettings(rawSettings);
  const { starters, bench } = optimizePprLineup(roster, settings);
  const weekly = starters.reduce((sum, player) => sum + (player.projection || 0) / 17, 0);
  const floorWeekly = starters.reduce((sum, player) => sum + (Number.isFinite(player.floor) ? player.floor : (player.projection || 0) * .82) / 17, 0);
  const ceilingWeekly = starters.reduce((sum, player) => sum + (Number.isFinite(player.ceiling) ? player.ceiling : (player.projection || 0) * 1.18) / 17, 0);
  const benchStrength = bench.reduce((sum, player) => sum + Math.max(0, player.vbd || 0), 0) / Math.max(1, bench.length);
  const byBye = starters.reduce((result, player) => player.byeWeek ? ({ ...result, [player.byeWeek]: (result[player.byeWeek] || 0) + 1 }) : result, {});
  const byeConflicts = Object.values(byBye).reduce((sum, count) => sum + Math.max(0, count - 2), 0);
  const unknownByes = starters.filter((player) => !player.byeWeek).length;
  const injuryConcentration = starters.reduce((sum, player) => sum + injuryWeight(player), 0);
  const teams = starters.reduce((result, player) => player.team ? ({ ...result, [player.team]: [...(result[player.team] || []), player] }) : result, {});
  let correlation = 0;
  for (const teamPlayers of Object.values(teams)) {
    if (teamPlayers.some((player) => player.position === "QB") && teamPlayers.some((player) => ["WR", "TE"].includes(player.position))) correlation += 1.5;
    if (teamPlayers.length >= 3) correlation -= (teamPlayers.length - 2) * .6;
  }
  const positionWeekly = Object.fromEntries(["QB", "RB", "WR", "TE"].map((position) => [position, starters.filter((player) => player.position === position).reduce((sum, player) => sum + (player.projection || 0) / 17, 0)]));
  let positionalAdvantage = 0;
  if (leagueRosters.length > 1) {
    const averages = Object.fromEntries(Object.keys(positionWeekly).map((position) => [position, leagueRosters.reduce((sum, other) => sum + optimizePprLineup(other, settings).starters.filter((player) => player.position === position).reduce((value, player) => value + (player.projection || 0) / 17, 0), 0) / leagueRosters.length]));
    positionalAdvantage = Object.keys(positionWeekly).reduce((sum, position) => sum + positionWeekly[position] - averages[position], 0);
  }
  const standardDeviation = Math.max(4, (ceilingWeekly - floorWeekly) / 3.3);
  const expectedWins = leagueRosters.length > 1 ? leagueRosters.reduce((sum, other) => {
    if (other === roster) return sum;
    const otherLineup = optimizePprLineup(other, settings).starters;
    const otherWeekly = otherLineup.reduce((value, player) => value + (player.projection || 0) / 17, 0);
    return sum + 1 / (1 + Math.exp(-(weekly - otherWeekly) / 7));
  }, 0) / (leagueRosters.length - 1) : .5;
  const score = weekly + floorWeekly * .18 + ceilingWeekly * .08 + benchStrength * .04 + positionalAdvantage * .25 + correlation - byeConflicts * 1.2 - injuryConcentration * 2.3;
  const explanations = [
    { label: "Starting lineup", value: `${weekly.toFixed(1)} projected PPR points/week`, impact: weekly },
    { label: "Bench", value: `${benchStrength.toFixed(1)} average positive VBD`, impact: benchStrength * .04 },
    { label: "Outcome range", value: `${floorWeekly.toFixed(1)}–${ceilingWeekly.toFixed(1)} weekly`, impact: ceilingWeekly - floorWeekly },
    { label: "Bye weeks", value: unknownByes ? `${byeConflicts} conflicts · ${unknownByes} unknown` : `${byeConflicts} material conflicts`, impact: -byeConflicts * 1.2 },
    { label: "Availability", value: `${injuryConcentration.toFixed(1)} weighted starter risks`, impact: -injuryConcentration * 2.3 },
    { label: "Correlation", value: correlation > 0 ? "Useful QB/pass-catcher stacking" : correlation < 0 ? "Concentrated team exposure" : "Neutral exposure", impact: correlation },
    { label: "Positional edge", value: `${positionalAdvantage >= 0 ? "+" : ""}${positionalAdvantage.toFixed(1)} points/week vs room`, impact: positionalAdvantage }
  ];
  return { score, weekly, floorWeekly, ceilingWeekly, standardDeviation, benchStrength, byeConflicts, unknownByes, injuryConcentration, correlation, positionalAdvantage, expectedWins, starters, bench, explanations };
}

function teamAtPick(index, teams) {
  const round = Math.floor(index / teams);
  const offset = index % teams;
  return round % 2 === 0 ? offset : teams - 1 - offset;
}

const needBonus = (player, roster, settings, round) => {
  const counts = roster.reduce((result, item) => ({ ...result, [item.position]: (result[item.position] || 0) + 1 }), {});
  const required = settings.rosterSlots[player.position] || 0;
  let bonus = (counts[player.position] || 0) < required ? 20 : 0;
  if (["K", "DST"].includes(player.position) && round < settings.rounds - 2) bonus -= 80;
  if (player.position === "QB" && !settings.superflex && (counts.QB || 0) >= 1 && round < settings.rounds - 3) bonus -= 35;
  if (settings.superflex && player.position === "QB" && (counts.QB || 0) < 2) bonus += 24;
  if (settings.tePremium && player.position === "TE") bonus += settings.tePremium * 8;
  return bonus;
};

const mixedStrategySignal = (belief, player, roster, round) => OPPONENT_STRATEGIES.reduce((sum, strategy) => sum + (belief?.probabilities?.[strategy.id] || 1 / OPPONENT_STRATEGIES.length) * strategySignal(strategy.id, player, roster, round), 0) * 7;

export function expectedOpponentBias(belief, player, roster, round) {
  return mixedStrategySignal(belief, player, roster, round);
}

export function backtestCompletedDraft({ players, picks, rosters, settings: rawSettings }) {
  const settings = normalizeLeagueSettings(rawSettings);
  const actualPlayers = players.map((player) => ({ ...player, projection: player.lastSeason?.fantasyPointsPpr ?? null })).filter((player) => Number.isFinite(player.projection));
  const actualById = new Map(actualPlayers.map((player) => [player.id, player]));
  const actualRosters = rosters.map((roster) => roster.map((player) => actualById.get(player.id)).filter(Boolean));
  const evaluations = actualRosters.map((roster) => evaluateRoster(roster, settings, actualRosters));
  const ranked = evaluations.map((evaluation, team) => ({ team, score: evaluation.score })).sort((a, b) => b.score - a.score);
  const rankByTeam = new Map(ranked.map((entry, index) => [entry.team, index + 1]));
  let regretTotal = 0;
  let regretCount = 0;
  const drafted = new Set();
  for (const pick of picks) {
    const selected = actualById.get(pick.playerId);
    if (selected) {
      const bestAvailable = actualPlayers.filter((player) => !drafted.has(player.id) && player.position === selected.position).sort((a, b) => b.projection - a.projection)[0];
      if (bestAvailable) { regretTotal += Math.max(0, bestAvailable.projection - selected.projection); regretCount++; }
    }
    drafted.add(pick.playerId);
  }
  const calibrated = players.filter((player) => Number.isFinite(player.lastSeason?.fantasyPointsPpr) && Number.isFinite(player.projection));
  const calibrationMae = calibrated.length ? calibrated.reduce((sum, player) => sum + Math.abs(player.projection - player.lastSeason.fantasyPointsPpr), 0) / calibrated.length : null;
  const segments = evaluations.map((evaluation, team) => ({
    team,
    draftSlot: team + 1,
    actualWeeklyPpr: evaluation.weekly,
    pointsAboveReplacement: actualRosters[team].reduce((sum, player) => sum + Math.max(0, player.vbd || 0), 0),
    finishRank: rankByTeam.get(team),
    playoffProbability: 1 / (1 + Math.exp((rankByTeam.get(team) - Math.min(4, settings.teams / 2)) * 1.1)),
    championshipProbability: Math.exp(evaluation.score / 18) / evaluations.reduce((sum, item) => sum + Math.exp(item.score / 18), 0)
  }));
  return {
    status: actualPlayers.length >= 100 ? "exploratory" : "insufficient-data",
    outcomeCoverage: actualPlayers.length / Math.max(1, players.length),
    recommendationRegret: regretCount ? regretTotal / regretCount : null,
    projectionCalibrationMae: calibrationMae,
    legalLineupRate: evaluations.filter((evaluation) => evaluation.starters.length >= Object.entries(settings.rosterSlots).filter(([key]) => key !== "BENCH").reduce((sum, [, value]) => sum + value, 0)).length / Math.max(1, evaluations.length),
    segments,
    limitation: "Uses the bundled prior-season outcomes as a chronological harness. Promote no global weights until draft-time ADP/projection snapshots from that same historical season are supplied."
  };
}

export function runMonteCarloRestOfDraft({ candidateIds, availablePlayers, rosters, currentPickIndex, currentTeam, settings: rawSettings, beliefs = {}, simulations = 36, seed = Date.now(), watchPlayerIds = [] }) {
  const settings = normalizeLeagueSettings(rawSettings);
  const totalPicks = Number(rawSettings.totalDraftPicks) || settings.teams * settings.rounds;
  const baseById = new Map(availablePlayers.map((player) => [player.id, player]));
  const results = Object.fromEntries(candidateIds.map((id) => [id, { weekly: [], wins: [], scores: [], survives: Object.fromEntries(watchPlayerIds.map((watchId) => [watchId, 0])) }]));
  for (const candidateId of candidateIds) {
    const forced = baseById.get(candidateId);
    if (!forced) continue;
    for (let iteration = 0; iteration < simulations; iteration++) {
      const random = seededRandom((Number(seed) || 1) + iteration * 7919 + String(candidateId).split("").reduce((sum, char) => sum + char.charCodeAt(0), 0));
      const simRosters = rosters.map((roster) => [...roster]);
      simRosters[currentTeam].push(forced);
      const remaining = availablePlayers.filter((player) => player.id !== candidateId).sort((a, b) => (b.vbd || 0) - (a.vbd || 0));
      let recordedNextTurn = false;
      for (let pick = currentPickIndex + 1; pick < totalPicks && remaining.length; pick++) {
        const team = teamAtPick(pick, settings.teams);
        if (team === currentTeam && !recordedNextTurn) {
          const remainingIds = new Set(remaining.map((player) => player.id));
          for (const watchId of watchPlayerIds) if (remainingIds.has(watchId)) results[candidateId].survives[watchId]++;
          recordedNextTurn = true;
        }
        const round = Math.floor(pick / settings.teams);
        const poolSize = Math.min(50, remaining.length);
        let bestIndex = 0;
        let bestScore = -Infinity;
        for (let index = 0; index < poolSize; index++) {
          const player = remaining[index];
          const score = (player.vbd || 0) + needBonus(player, simRosters[team], settings, round) + mixedStrategySignal(beliefs[team], player, simRosters[team], round) + (-Math.log(-Math.log(Math.max(.0001, random())))) * 5;
          if (score > bestScore) { bestScore = score; bestIndex = index; }
        }
        simRosters[team].push(remaining.splice(bestIndex, 1)[0]);
      }
      const evaluation = evaluateRoster(simRosters[currentTeam], settings, simRosters);
      results[candidateId].weekly.push(evaluation.weekly);
      results[candidateId].wins.push(evaluation.expectedWins);
      results[candidateId].scores.push(evaluation.score);
    }
  }
  const summarize = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return Object.fromEntries(Object.entries(results).map(([id, result]) => [id, {
    simulations,
    expectedWeekly: summarize(result.weekly),
    expectedWinRate: summarize(result.wins),
    expectedRosterScore: summarize(result.scores),
    downsideWeekly: [...result.weekly].sort((a, b) => a - b)[Math.floor(result.weekly.length * .15)] || 0,
    upsideWeekly: [...result.weekly].sort((a, b) => a - b)[Math.floor(result.weekly.length * .85)] || 0,
    survival: Object.fromEntries(Object.entries(result.survives).map(([watchId, count]) => [watchId, count / Math.max(1, simulations)]))
  }]));
}
