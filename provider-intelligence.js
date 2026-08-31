import { evaluateRoster } from "./draft-intelligence.js";

export const LEARNING_PROFILE_KEY = "war-room-provider-learning-v1";
export const DEFAULT_LEARNING_PROFILE = Object.freeze({
  version: 1,
  completedDrafts: 0,
  providerInfluence: .55,
  regretEma: null,
  providerWeights: { fantasypros: .5, sportsdataio: .5 },
  processedDraftIds: [],
  updatedAt: null
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round1 = (value) => Math.round(value * 10) / 10;

export function loadLearningProfile(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(LEARNING_PROFILE_KEY));
    if (saved?.version === 1) return { ...DEFAULT_LEARNING_PROFILE, ...saved, providerWeights: { ...DEFAULT_LEARNING_PROFILE.providerWeights, ...(saved.providerWeights || {}) }, processedDraftIds: saved.processedDraftIds || [] };
  } catch { /* Invalid learning state should never break the draft room. */ }
  return { ...DEFAULT_LEARNING_PROFILE, providerWeights: { ...DEFAULT_LEARNING_PROFILE.providerWeights }, processedDraftIds: [] };
}

export function saveLearningProfile(profile, storage = globalThis.localStorage) {
  storage?.setItem(LEARNING_PROFILE_KEY, JSON.stringify(profile));
}

function providerValues(source, weights) {
  return ["fantasypros", "sportsdataio"].map((provider) => ({ provider, value: Number(source?.[provider]?.projection), weight: Number(weights?.[provider]) || .5 })).filter((entry) => Number.isFinite(entry.value));
}

export function applyProviderProjections(players, snapshot, profile = DEFAULT_LEARNING_PROFILE) {
  const ageHours = (Date.now() - Date.parse(snapshot?.generatedAt)) / 3_600_000;
  const snapshotFresh = Number.isFinite(ageHours) && ageHours >= -1 && ageHours <= 168;
  const usableProviders = snapshotFresh ? Object.entries(snapshot?.providers || {}).filter(([, provider]) => provider.status === "usable" && provider.matches >= 50).map(([provider]) => provider) : [];
  let matchedPlayers = 0;
  for (const player of players) {
    const source = Object.fromEntries(usableProviders.map((provider) => [provider, snapshot?.players?.[player.id]?.[provider]]));
    const values = providerValues(source, profile.providerWeights);
    if (!values.length) continue;
    const totalWeight = values.reduce((sum, entry) => sum + entry.weight, 0);
    const consensus = values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
    const influence = clamp(profile.providerInfluence * (values.length === 1 ? .72 : 1), .25, .75);
    const prior = player.projection;
    const disagreement = values.length > 1 ? Math.abs(values[0].value - values[1].value) : 0;
    player.localProjection = prior;
    player.providerProjection = round1(consensus);
    player.providerSources = Object.fromEntries(values.map((entry) => [entry.provider, entry.value]));
    player.providerDisagreement = round1(disagreement);
    player.projection = round1(prior * (1 - influence) + consensus * influence);
    const uncertainty = Math.max(Number(player.standardDeviation) || 0, disagreement / 2, player.projection * .08);
    player.standardDeviation = round1(uncertainty);
    player.floor = round1(Math.min(Number(player.floor) || player.projection * .82, player.projection - uncertainty));
    player.ceiling = round1(Math.max(Number(player.ceiling) || player.projection * 1.18, player.projection + uncertainty));
    const providerAdp = values.map((entry) => Number(source?.[entry.provider]?.adp)).filter(Number.isFinite);
    if (providerAdp.length) player.adp = round1(((Number(player.adp) || providerAdp[0]) + providerAdp.reduce((sum, value) => sum + value, 0) / providerAdp.length) / 2);
    player.modelSource = "multi-provider";
    matchedPlayers++;
  }
  return { matchedPlayers, usableProviders, influence: profile.providerInfluence, snapshotFresh, ageHours };
}

const gradeForRank = (rank, count) => {
  const percentile = count > 1 ? 1 - rank / (count - 1) : .5;
  return percentile >= .9 ? "A" : percentile >= .72 ? "A−" : percentile >= .55 ? "B+" : percentile >= .38 ? "B" : percentile >= .2 ? "C+" : "C";
};

export function providerRosterGrades(rosters, settings, provider = "consensus") {
  const coverage = rosters.map((roster) => roster.filter((player) => provider === "consensus" ? Number.isFinite(player.providerProjection) : Number.isFinite(player.providerSources?.[provider])).length);
  const projectedRosters = rosters.map((roster) => roster.map((player) => {
    const sourceValues = Object.values(player.providerSources || {}).filter(Number.isFinite);
    const projection = provider === "consensus" ? player.providerProjection : player.providerSources?.[provider];
    return { ...player, projection: Number.isFinite(projection) ? projection : sourceValues.length ? sourceValues.reduce((sum, value) => sum + value, 0) / sourceValues.length : player.projection };
  }));
  const evaluations = projectedRosters.map((roster) => evaluateRoster(roster, settings, projectedRosters));
  const ranking = evaluations.map((evaluation, team) => ({ team, score: evaluation.score })).sort((a, b) => b.score - a.score);
  const rankByTeam = new Map(ranking.map((entry, index) => [entry.team, index]));
  return evaluations.map((evaluation, team) => ({ team, score: evaluation.score, weekly: evaluation.weekly, expectedWins: evaluation.expectedWins, coveredPlayers: coverage[team], rosterSize: rosters[team].length, rank: rankByTeam.get(team) + 1, grade: gradeForRank(rankByTeam.get(team), rosters.length) }));
}

export function updateLearningFromDraft(profile, { draftId, picks, keepers = [], players, userSlot, teams, draftFormat = "snake" }) {
  const current = { ...DEFAULT_LEARNING_PROFILE, ...profile, providerWeights: { ...DEFAULT_LEARNING_PROFILE.providerWeights, ...(profile?.providerWeights || {}) }, processedDraftIds: [...(profile?.processedDraftIds || [])] };
  if (!draftId || current.processedDraftIds.includes(draftId)) return { profile: current, updated: false, reason: "already-processed" };
  if (draftFormat === "auction") return { profile: current, updated: false, reason: "auction-learning-requires-price-aware-regret" };
  const byId = new Map(players.map((player) => [player.id, player]));
  const drafted = new Set(keepers.map((keeper) => keeper.playerId));
  const regrets = [];
  for (const pick of [...picks].sort((a, b) => a.index - b.index)) {
    const chosen = byId.get(pick.playerId);
    if (pick.team === userSlot && chosen?.providerProjection && Object.keys(chosen.providerSources || {}).length >= 2) {
      const best = players.filter((player) => !drafted.has(player.id) && player.position === chosen.position && Object.keys(player.providerSources || {}).length >= 2).sort((a, b) => b.providerProjection - a.providerProjection)[0];
      if (best) regrets.push(Math.max(0, best.providerProjection - chosen.providerProjection));
    }
    drafted.add(pick.playerId);
  }
  if (regrets.length < Math.max(5, Math.floor(teams / 2))) return { profile: current, updated: false, reason: "insufficient-dual-provider-picks", samples: regrets.length };
  const regret = regrets.reduce((sum, value) => sum + value, 0) / regrets.length;
  const regretEma = current.regretEma == null ? regret : current.regretEma * .8 + regret * .2;
  const adjustment = clamp((regretEma - 4) / 500, -.008, .02);
  const updatedProfile = {
    ...current,
    completedDrafts: current.completedDrafts + 1,
    providerInfluence: clamp(current.providerInfluence + adjustment, .35, .75),
    regretEma: round1(regretEma),
    processedDraftIds: [...current.processedDraftIds.slice(-249), draftId],
    updatedAt: new Date().toISOString()
  };
  return { profile: updatedProfile, updated: true, regret: round1(regret), samples: regrets.length, adjustment };
}
