const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const mean = (values) => {
  const clean = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
};

const POSITION_BASELINES = { QB: 18, RB: 12.5, WR: 12, TE: 9.5, K: 8, DST: 8 };
const POSITION_SCARCITY = { QB: 0.82, RB: 1.14, WR: 1.08, TE: 1.03, K: 0.45, DST: 0.45 };
const UPSIDE_AGE_CURVES = { QB: [24, 30, 35], RB: [22, 25, 28], WR: [23, 27, 31], TE: [24, 28, 32] };

function injuryMultiplier(player, live = {}) {
  const status = String(live.injuryStatus || player.injury || live.status || "").toLowerCase();
  if (!status) return 1;
  if (/ir|out|pup|suspend/.test(status)) return 0.68;
  if (/doubt/.test(status)) return 0.78;
  if (/question|limited|dnp|did not practice/.test(status)) return 0.9;
  return 0.96;
}

function roleScore(player, live = {}) {
  const current = live.currentSeason || {};
  const games = Math.max(1, num(current.games, 0));
  const targetsPerGame = num(current.targets) / games;
  const carriesPerGame = num(current.carries) / games;
  const receptionsPerGame = num(current.receptions) / games;
  const targetShare = num(current.targetShare, num(live.lastSeason?.targetShare));
  const depthRaw = Number(live.depthChartOrder ?? player.depthOrder);
  const depth = Number.isFinite(depthRaw) ? depthRaw : 3;
  const trend = Math.log10(1 + num(live.trendingAdds)) - Math.log10(1 + num(live.trendingDrops));
  let score = 50;
  if (player.position === "RB") score += clamp(carriesPerGame * 1.6 + targetsPerGame * 2.3 - 19, -22, 25);
  if (player.position === "WR") score += clamp(targetsPerGame * 3 + targetShare * 58 - 21, -22, 28);
  if (player.position === "TE") score += clamp(targetsPerGame * 3.2 + targetShare * 52 - 16, -22, 28);
  if (player.position === "QB") score += clamp(num(current.passAttempts) / games * 0.65 + num(current.carries) / games * 1.3 - 20, -20, 25);
  score += depth === 1 ? 8 : depth === 2 ? 1 : -8;
  score += clamp(trend * 4, -8, 8);
  if (receptionsPerGame > 5 && ["WR", "TE", "RB"].includes(player.position)) score += 3;
  return clamp(score, 5, 95);
}

function developmentScore(player) {
  const position = player.position;
  const age = num(player.age, 0);
  const experience = num(player.yearsExperience, 0);
  if (!UPSIDE_AGE_CURVES[position]) return 50;
  const [early, peak, decline] = UPSIDE_AGE_CURVES[position];
  let score = 55;
  if (!age) score = experience <= 1 ? 68 : 52;
  else if (age <= early) score = 78;
  else if (age <= peak) score = 72 - (age - early) * 3;
  else if (age <= decline) score = 56 - (age - peak) * 5;
  else score = Math.max(22, 40 - (age - decline) * 6);
  if (experience <= 1) score += 8;
  if (player.depthOrder === 1) score += 4;
  return clamp(score, 10, 95);
}

function teamEnvironment(player, context = {}) {
  const team = context.teams?.[player.team] || {};
  const offense = team.offense || {};
  const scoring = num(offense.pointsPerGame, 22);
  const passRate = num(offense.passRate, 0.57);
  const touchdowns = num(offense.offensiveTouchdownsPerGame, 2.3);
  let score = 50 + clamp((scoring - 22) * 1.9, -16, 18) + clamp((touchdowns - 2.3) * 4, -8, 10);
  if (["WR", "TE", "QB"].includes(player.position)) score += clamp((passRate - 0.57) * 70, -8, 8);
  if (player.position === "RB") score -= clamp((passRate - 0.57) * 55, -7, 7);
  return clamp(score, 15, 90);
}

function opponentDifficulty(teamCode, position, context = {}, horizon = 6) {
  const team = context.teams?.[teamCode] || {};
  const remaining = (team.remainingSchedule || []).slice(0, horizon);
  if (!remaining.length) return { score: 50, label: "Neutral", opponents: [] };
  const opponentScores = remaining.map((game) => {
    const defense = context.teams?.[game.opponent]?.defense || {};
    const positionIndex = defense.fantasyAllowedIndex?.[position];
    if (Number.isFinite(Number(positionIndex))) return 50 + Number(positionIndex) * 25;
    const pointsAllowed = num(defense.pointsAllowedPerGame, 22);
    return 50 + clamp((pointsAllowed - 22) * 2, -18, 18);
  });
  const score = clamp(mean(opponentScores), 15, 85);
  return { score, label: score >= 60 ? "Favorable" : score <= 40 ? "Difficult" : "Neutral", opponents: remaining.map((game) => game.opponent) };
}

function coverageFit(player, context = {}) {
  const team = context.teams?.[player.team];
  const next = team?.remainingSchedule?.[0];
  const defense = next ? context.teams?.[next.opponent]?.defense : null;
  const profile = defense?.coverageProfile;
  if (!profile) return { score: 50, available: false, note: "Coverage-specific data unavailable; not included in the score." };
  const slot = String(player.depthPosition || "").toUpperCase().includes("S");
  const manRate = num(profile.manRate, 0);
  const zoneRate = num(profile.zoneRate, 0);
  const twoHighRate = num(profile.twoHighRate, 0);
  let score = 50;
  if (slot && zoneRate > 0.55) score += 6;
  if (player.position === "TE" && twoHighRate > 0.45) score += 5;
  if (player.position === "WR" && player.depthOrder === 1 && manRate > 0.35) score += 3;
  return { score: clamp(score, 35, 65), available: true, note: profile.label || "Coverage tendency incorporated." };
}

function currentPace(player, live = {}, seasonWeek = 4) {
  const current = live.currentSeason || {};
  const games = num(current.games, 0);
  const points = num(current.fantasyPointsPpr, 0);
  if (!games || !points) return null;
  const ppg = points / games;
  const remainingGames = Math.max(1, 17 - Math.max(0, seasonWeek - 1));
  return { ppg, remainingPoints: ppg * remainingGames };
}

function baselineRos(player, live = {}, context = {}) {
  const week = num(context.season?.week, 4);
  const seasonProjection = Math.max(0, num(player.projection, num(player.baseProjection, 0)));
  const remainingFraction = clamp((18 - week) / 17, 0.08, 1);
  const projectionRos = seasonProjection * remainingFraction;
  const pace = currentPace(player, live, week);
  if (!pace) return projectionRos;
  const games = num(live.currentSeason?.games, 0);
  const paceWeight = clamp(games / 8, 0.12, 0.58);
  return projectionRos * (1 - paceWeight) + pace.remainingPoints * paceWeight;
}

function replacementPpg(position) { return POSITION_BASELINES[position] || 8; }

export function evaluatePlayer(player, context = {}) {
  const live = context.players?.[player.id] || {};
  const ros = baselineRos(player, live, context);
  const role = roleScore(player, live);
  const development = developmentScore(player);
  const environment = teamEnvironment(player, context);
  const schedule = opponentDifficulty(player.team, player.position, context);
  const coverage = coverageFit(player, context);
  const injury = injuryMultiplier(player, live);
  const seasonWeek = num(context.season?.week, 4);
  const remainingGames = Math.max(1, 18 - seasonWeek);
  const baselineWeekly = ros / remainingGames;
  const vorpWeekly = baselineWeekly - replacementPpg(player.position);
  const scarcity = POSITION_SCARCITY[player.position] || 0.6;
  const roleAdj = (role - 50) * 0.085;
  const developmentAdj = (development - 50) * 0.045;
  const environmentAdj = (environment - 50) * 0.05;
  const scheduleAdj = (schedule.score - 50) * 0.055;
  const coverageAdj = coverage.available ? (coverage.score - 50) * 0.035 : 0;
  const adjustedWeekly = Math.max(0, (baselineWeekly + roleAdj + developmentAdj + environmentAdj + scheduleAdj + coverageAdj) * injury);
  const rawValue = adjustedWeekly * 3.1 + Math.max(-5, vorpWeekly) * 4.6 * scarcity + role * 0.28 + development * 0.12;
  const value = clamp(rawValue, 1, 100);
  const floor = clamp(value - (100 - role) * 0.11 - (1 - injury) * 30, 1, 100);
  const ceiling = clamp(value + development * 0.12 + Math.max(0, role - 55) * 0.13 + Math.max(0, schedule.score - 50) * 0.09, 1, 100);
  const reasons = [
    { key: "role", label: "Usage / role", score: role, detail: role >= 62 ? "Strong workload and/or depth-chart position." : role <= 42 ? "Role is currently fragile or limited." : "Workload is broadly stable." },
    { key: "schedule", label: "Upcoming schedule", score: schedule.score, detail: schedule.label + (schedule.opponents.length ? " · next: " + schedule.opponents.join(", ") : "") },
    { key: "environment", label: "Offense", score: environment, detail: environment >= 60 ? "Above-average scoring environment." : environment <= 40 ? "Below-average scoring environment." : "Neutral team environment." },
    { key: "upside", label: "Upside", score: development, detail: development >= 65 ? "Age/experience curve leaves meaningful growth potential." : development <= 40 ? "Value depends more on present production than developmental upside." : "Moderate development profile." },
    { key: "health", label: "Availability", score: Math.round(injury * 100), detail: injury < 0.85 ? "Current availability meaningfully reduces rest-of-season value." : injury < 1 ? "Minor availability discount applied." : "No current availability discount." },
    { key: "coverage", label: "Coverage fit", score: coverage.score, detail: coverage.note }
  ];
  return { playerId: player.id, name: player.name, position: player.position, team: player.team, value: Number(value.toFixed(1)), floor: Number(floor.toFixed(1)), ceiling: Number(ceiling.toFixed(1)), rosPoints: Number((adjustedWeekly * remainingGames).toFixed(1)), weekly: Number(adjustedWeekly.toFixed(2)), baselineWeekly: Number(baselineWeekly.toFixed(2)), role, development, environment, schedule: schedule.score, injuryMultiplier: injury, coverageAvailable: coverage.available, reasons };
}

function rosterNeeds(roster, settings = {}) {
  const starters = settings.rosterSlots || { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2 };
  const counts = roster.reduce((acc, player) => { acc[player.position] = (acc[player.position] || 0) + 1; return acc; }, {});
  return {
    QB: Math.max(0, num(starters.QB, 1) - num(counts.QB)),
    RB: Math.max(0, num(starters.RB, 2) + num(starters.FLEX, 2) * 0.45 - num(counts.RB)),
    WR: Math.max(0, num(starters.WR, 2) + num(starters.FLEX, 2) * 0.45 - num(counts.WR)),
    TE: Math.max(0, num(starters.TE, 1) - num(counts.TE))
  };
}

function lineupStrength(roster, context, settings = {}) {
  const evaluated = roster.map((player) => ({ player, eval: evaluatePlayer(player, context) }));
  const slots = settings.rosterSlots || { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2 };
  const taken = new Set();
  const pickTop = (positions, count) => evaluated.filter((item) => positions.includes(item.player.position) && !taken.has(item.player.id)).sort((a, b) => b.eval.weekly - a.eval.weekly).slice(0, count).map((item) => { taken.add(item.player.id); return item.eval.weekly; });
  const scores = [...pickTop(["QB"], num(slots.QB, 1)), ...pickTop(["RB"], num(slots.RB, 2)), ...pickTop(["WR"], num(slots.WR, 2)), ...pickTop(["TE"], num(slots.TE, 1)), ...pickTop(["RB", "WR", "TE"], num(slots.FLEX, 2)), ...pickTop(["QB", "RB", "WR", "TE"], num(slots.SUPERFLEX, 0))];
  return scores.reduce((sum, value) => sum + value, 0);
}

export function evaluateTrade({ give = [], receive = [], myRoster = [], context = {}, settings = {} }) {
  const giveEval = give.map((player) => evaluatePlayer(player, context));
  const receiveEval = receive.map((player) => evaluatePlayer(player, context));
  const giveValue = giveEval.reduce((sum, item) => sum + item.value, 0);
  const receiveValue = receiveEval.reduce((sum, item) => sum + item.value, 0);
  const removeIds = new Set(give.map((player) => player.id));
  const postRoster = [...myRoster.filter((player) => !removeIds.has(player.id)), ...receive];
  const beforeLineup = lineupStrength(myRoster, context, settings);
  const afterLineup = lineupStrength(postRoster, context, settings);
  const lineupDelta = afterLineup - beforeLineup;
  const needsBefore = rosterNeeds(myRoster, settings);
  const needsAfter = rosterNeeds(postRoster, settings);
  const needDelta = Object.keys(needsBefore).reduce((sum, position) => sum + (needsBefore[position] - needsAfter[position]), 0);
  const rawDelta = receiveValue - giveValue;
  const adjustedDelta = rawDelta + lineupDelta * 2.2 + needDelta * 2.5;
  const total = Math.max(1, (giveValue + receiveValue) / 2);
  const fairness = clamp(100 - Math.abs(receiveValue - giveValue) / total * 100, 0, 100);
  let verdict = "Even";
  if (adjustedDelta >= 10) verdict = "Strong gain";
  else if (adjustedDelta >= 3.5) verdict = "Slight gain";
  else if (adjustedDelta <= -10) verdict = "Strong loss";
  else if (adjustedDelta <= -3.5) verdict = "Slight loss";
  return { giveValue: Number(giveValue.toFixed(1)), receiveValue: Number(receiveValue.toFixed(1)), valueDelta: Number(rawDelta.toFixed(1)), adjustedDelta: Number(adjustedDelta.toFixed(1)), lineupDelta: Number(lineupDelta.toFixed(2)), fairness: Number(fairness.toFixed(0)), verdict, give: giveEval, receive: receiveEval, postRoster, needsBefore, needsAfter };
}

export function suggestTrades({ myRoster = [], opponents = [], context = {}, settings = {}, maxSuggestions = 8 }) {
  const myValues = myRoster.map((player) => ({ player, eval: evaluatePlayer(player, context) })).sort((a, b) => b.eval.value - a.eval.value);
  const suggestions = [];
  for (const opponent of opponents) {
    const opponentRoster = opponent.roster || [];
    const theirValues = opponentRoster.map((player) => ({ player, eval: evaluatePlayer(player, context) })).sort((a, b) => b.eval.value - a.eval.value);
    const theirNeeds = rosterNeeds(opponentRoster, settings);
    const myNeeds = rosterNeeds(myRoster, settings);
    for (const target of theirValues.slice(0, 10)) {
      if (target.eval.value < 25) continue;
      const targetNeed = myNeeds[target.player.position] || 0;
      const candidateOutgoing = myValues.filter((item) => item.player.id !== target.player.id && (theirNeeds[item.player.position] > 0 || item.eval.value >= target.eval.value * 0.72));
      for (const outgoing of candidateOutgoing.slice(0, 10)) {
        const oneForOne = evaluateTrade({ give: [outgoing.player], receive: [target.player], myRoster, context, settings });
        if (Math.abs(oneForOne.valueDelta) <= 14 && oneForOne.adjustedDelta > 1.5) {
          suggestions.push({ opponent: opponent.name, opponentId: opponent.id, give: [outgoing.player], receive: [target.player], analysis: oneForOne, rationale: targetNeed > 0 ? "Fills a " + target.player.position + " need while keeping the value gap manageable." : "Improves projected starting-lineup output." });
        }
        if (outgoing.eval.value < target.eval.value * 0.86) {
          const sweetener = myValues.find((item) => item.player.id !== outgoing.player.id && item.eval.value >= 12 && item.eval.value <= 38 && (theirNeeds[item.player.position] > 0 || item.player.position !== target.player.position));
          if (sweetener) {
            const twoForOne = evaluateTrade({ give: [outgoing.player, sweetener.player], receive: [target.player], myRoster, context, settings });
            if (Math.abs(twoForOne.valueDelta) <= 15 && twoForOne.adjustedDelta > 2.5) suggestions.push({ opponent: opponent.name, opponentId: opponent.id, give: [outgoing.player, sweetener.player], receive: [target.player], analysis: twoForOne, rationale: "Consolidates two assets into a stronger starter while addressing at least one plausible opponent need." });
          }
        }
      }
    }
  }
  const unique = new Map();
  for (const suggestion of suggestions.sort((a, b) => b.analysis.adjustedDelta - a.analysis.adjustedDelta || b.analysis.fairness - a.analysis.fairness)) {
    const key = suggestion.opponentId + ":" + suggestion.give.map((p) => p.id).sort().join("+") + "=>" + suggestion.receive.map((p) => p.id).sort().join("+");
    if (!unique.has(key)) unique.set(key, suggestion);
  }
  return [...unique.values()].slice(0, maxSuggestions);
}
