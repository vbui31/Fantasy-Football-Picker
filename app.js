import { enrichPlayerModel, scoreCandidate } from "./draft-model.js";
import { buildProjectionDataset, normalizedName, parseCsv } from "./ffanalytics-data.js";
import { backtestCompletedDraft, createOpponentBeliefs, dominantOpponentStyle, evaluateRoster, expectedOpponentBias, normalizeLeagueSettings, runMonteCarloRestOfDraft, updateOpponentBelief } from "./draft-intelligence.js";
import { createDraftId, getDraftLogs, historicalCalibration, putDraftLog, settingsFingerprint } from "./draft-audit.js";
import { applyProviderProjections, loadLearningProfile, providerRosterGrades, saveLearningProfile, updateLearningFromDraft } from "./provider-intelligence.js";

const POSITIONS = ["ALL", "RB", "WR", "QB", "TE", "FLEX", "K", "DST"];
const OPPONENT_PROFILE = {
  source: "Fantasy Meltdown ADP room · 10 full mocks · 2026-08-30",
  targetRoster: { QB: 1.7, RB: 4.2, WR: 5.4, TE: 1.7, K: 1, DST: 1 },
  medianFirstRound: { QB: 7, TE: 7, K: 15, DST: 14 }
};
const STORAGE_KEY = "war-room-draft-v1";
const GRADE_MODEL_VERSION = "ppr-grade-v3";

const elements = Object.fromEntries([
  "playerRows", "poolCount", "searchInput", "positionFilters", "methodology", "clockTeam", "roundLabel",
  "pickLabel", "clockTrack", "recommendationCard", "alternatives", "confidence", "rosterTitle", "rosterGrade",
  "needsStrip", "rosterList", "historyList", "undoButton", "settingsButton", "simulateButton", "setupDialog",
  "setupForm", "teamCount", "userSlot", "roundCount", "autoOpponents", "newDraftButton", "toast", "saveState",
  "projectionFile", "importStatus", "clearModelButton", "modelState", "fullSimButton", "simulationPace",
  "viewLeagueButton", "leagueDialog", "closeLeagueButton", "leagueGrid", "leagueSummary", "compareButton", "compareCount",
  "scarcityPanel", "compareDialog", "closeCompareButton", "compareContent", "draftPreset", "draftFormat", "scoringFormat",
  "slotQB", "slotRB", "slotWR", "slotTE", "slotFlex", "slotSuperflex", "slotK", "slotDST", "tePremium", "auctionBudget",
  "sleeperLeagueId", "importSleeperButton", "sleeperImportStatus", "keepersInput", "tradedPicksInput", "exportDraftButton",
  "shareDraftButton", "runBacktestButton", "draftLogButton", "providerAudit"
].map((id) => [id, document.getElementById(id)]));

let dataset;
let liveContext = null;
let activePosition = "ALL";
let toastTimer;
let simulationNonce = 0;
let isSimulating = false;
let comparisonSelection = new Set();
let monteCarlo = { key: null, results: null, running: false };
let draftHistory = [];
let providerSnapshot = null;
let providerSummary = { matchedPlayers: 0, usableProviders: [], influence: 0 };
let learningProfile = loadLearningProfile();
let state = loadState();

function defaultState() {
  const settings = normalizeLeagueSettings({ teams: 10, userSlot: 5, rounds: 15, autoOpponents: true, simulationPace: 220, preset: "balanced" });
  return { version: 3, draftId: createDraftId(), startedAt: new Date().toISOString(), settings, picks: [], keepers: [], tradedPicks: {}, cursor: 0, model: null, opponentBeliefs: createOpponentBeliefs(settings.teams, settings.userSlot), feedback: [], leagueImport: null, simulationSeed: Math.floor(Math.random() * 2 ** 31) };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if ([1, 2, 3].includes(saved?.version) && Array.isArray(saved.picks)) {
      const defaults = defaultState();
      const settings = normalizeLeagueSettings({ ...defaults.settings, ...saved.settings });
      return { ...defaults, ...saved, version: 3, draftId: saved.draftId || createDraftId(), startedAt: saved.startedAt || new Date().toISOString(), settings, keepers: saved.keepers || [], tradedPicks: saved.tradedPicks || {}, cursor: Number.isInteger(saved.cursor) ? saved.cursor : saved.picks.length, opponentBeliefs: saved.opponentBeliefs || createOpponentBeliefs(settings.teams, settings.userSlot), feedback: saved.feedback || [] };
    }
  } catch { /* A fresh board is safer than a broken saved state. */ }
  return defaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  elements.saveState.innerHTML = "<i></i> Saved locally";
}

function teamName(index) { return index === state.settings.userSlot ? `Your team · ${index + 1}` : `Team ${index + 1}`; }

function keeperSlotSet() {
  const total = state.settings.teams * state.settings.rounds;
  const needed = state.keepers.reduce((result, keeper) => ({ ...result, [keeper.team]: (result[keeper.team] || 0) + 1 }), {});
  const reserved = new Set();
  for (let index = total - 1; index >= 0; index--) {
    const round = Math.floor(index / state.settings.teams);
    const offset = index % state.settings.teams;
    const team = round % 2 === 0 ? offset : state.settings.teams - 1 - offset;
    if ((needed[team] || 0) > 0) { reserved.add(index); needed[team]--; }
  }
  return reserved;
}

function nextOpenDraftIndex(start = 0) {
  const reserved = keeperSlotSet();
  let index = start;
  while (reserved.has(index)) index++;
  return index;
}

function currentDraftIndex() { return nextOpenDraftIndex(Number.isInteger(state.cursor) ? state.cursor : state.picks.length); }

function pickContext(pickIndex = currentDraftIndex()) {
  const { teams } = state.settings;
  const round = Math.floor(pickIndex / teams);
  const offset = pickIndex % teams;
  const scheduledTeam = round % 2 === 0 ? offset : teams - 1 - offset;
  const team = Number.isInteger(state.tradedPicks?.[pickIndex + 1]) ? state.tradedPicks[pickIndex + 1] : scheduledTeam;
  return { round, offset, team, overall: pickIndex + 1 };
}

function isComplete() { return currentDraftIndex() >= state.settings.teams * state.settings.rounds || state.picks.length + state.keepers.length >= state.settings.teams * state.settings.rounds; }

function nextSelectionForTeam(pickIndex, team) {
  const total = state.settings.teams * state.settings.rounds;
  const reserved = keeperSlotSet();
  for (let index = pickIndex + 1; index < total; index++) if (!reserved.has(index) && pickContext(index).team === team) return index;
  return null;
}

function availablePlayers() {
  const drafted = new Set([...state.picks.map((pick) => pick.playerId), ...state.keepers.map((keeper) => keeper.playerId)]);
  return dataset.players.filter((player) => !drafted.has(player.id) && (!dataset.liveData?.fresh || !["inactive", "retired"].includes(String(player.liveStatus || "").toLowerCase())));
}

function applyLiveContext(context) {
  const ageHours = (Date.now() - Date.parse(context?.generatedAt)) / 3_600_000;
  const fresh = Number.isFinite(ageHours) && ageHours <= 48 && context?.quality?.status === "usable";
  let matches = 0;
  if (fresh) {
    for (const player of dataset.players) {
      const live = context.players?.[player.id];
      if (!live) continue;
      matches++;
      player.team = live.team || player.team;
      player.liveStatus = live.status;
      player.injury = live.injuryStatus || null;
      player.injuryBodyPart = live.injuryBodyPart;
      player.injuryStartDate = live.injuryStartDate;
      player.practiceParticipation = live.practiceParticipation;
      player.practiceDescription = live.practiceDescription;
      player.newsUpdated = live.newsUpdated;
      player.trendingAdds = live.trendingAdds || 0;
      player.trendingDrops = live.trendingDrops || 0;
      player.lastSeason = live.lastSeason;
      player.byeWeek = live.byeWeek;
      if (Number.isFinite(live.depthChartOrder)) player.depthOrder = live.depthChartOrder;
    }
  }
  dataset.liveData = { fresh, matches, generatedAt: context?.generatedAt || null, ageHours };
}

function recalculateModel() {
  for (const player of dataset.players) {
    player.projection = player.baseProjection;
    player.floor = null;
    player.ceiling = null;
    player.uncertainty = null;
    player.standardDeviation = null;
    player.tier = null;
    player.consensusTier = null;
    player.adp = null;
    player.adpDeviation = null;
    player.auctionValue = null;
    player.expertRank = null;
    player.localProjection = null;
    player.providerProjection = null;
    player.providerSources = null;
    player.providerDisagreement = null;
    player.modelSource = "registry";
  }

  if (state.model?.data) {
    for (const player of dataset.players) {
      const imported = state.model.data[player.id];
      if (!imported) continue;
      Object.assign(player, imported, { modelSource: "ffanalytics" });
    }
  }

  providerSummary = applyProviderProjections(dataset.players, providerSnapshot, learningProfile);

  const replacement = enrichPlayerModel(dataset.players, state.settings);

  dataset.players.sort((a, b) => b.vbd - a.vbd || b.projection - a.projection || a.sourceRank - b.sourceRank);
  dataset.players.forEach((player, index) => { player.rank = index + 1; });
  const consensus = state.model?.source === "ffanalytics";
  const providersReady = providerSummary.usableProviders.length > 0;
  const liveLabel = dataset.liveData?.fresh ? ` · Live ${dataset.liveData.matches}` : "";
  elements.modelState.textContent = providersReady ? `${providerSummary.usableProviders.length} provider${providerSummary.usableProviders.length > 1 ? "s" : ""} · ${providerSummary.matchedPlayers} matched${liveLabel}` : consensus ? `Consensus · ${state.model.matches} matched${liveLabel}` : `Registry model${liveLabel}`;
  elements.modelState.classList.toggle("consensus", consensus || providersReady);
  elements.importStatus.textContent = consensus
    ? `${state.model.matches} players matched from ${state.model.fileName}${state.model.scoringFormat ? ` · ${state.model.scoringFormat.toUpperCase()}` : ""}${state.model.generatedAt ? ` · generated ${new Intl.DateTimeFormat().format(new Date(state.model.generatedAt))}` : ""}. ${state.model.unmatched} rows were unmatched or unusable.`
    : "No consensus file loaded.";
  elements.clearModelButton.hidden = !consensus;
  const liveMethod = dataset.liveData?.fresh
    ? ` Daily Sleeper availability, practice, depth-chart, and trend context refreshed ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dataset.liveData.generatedAt))}; nflverse prior-season stats provide historical context. News timestamps are metadata only, not headline sentiment.`
    : liveContext ? " The bundled live context is older than 48 hours, so availability overrides are disabled." : " Live context is unavailable; registry metadata remains in use.";
  const providerMethod = providersReady ? ` FantasyPros and SportsDataIO contribute ${Math.round(learningProfile.providerInfluence * 100)}% of the projection blend when both cover a player; ${providerSummary.matchedPlayers} players currently have independent provider evidence. Provider disagreement expands uncertainty rather than being averaged away.` : " FantasyPros and SportsDataIO snapshots are not configured, so no provider-derived grade or learning adjustment is active.";
  elements.methodology.textContent = (consensus
    ? `ffanalytics weighted consensus from ${state.model.fileName} supplies projections, ranges, expert ranks, ADP, auction values, and uncertainty. Research-derived reliability, phase-aware floor/ceiling utility, dynamic replacement levels (${Object.entries(replacement).map(([position, rank]) => `${position}${rank}`).join(", ")}), roster feasibility, probabilistic tiers, and next-turn availability are recalculated for this room.`
    : `${dataset.methodology} Research-derived reliability, rookie cold-start handling, roster feasibility, dynamic replacement levels, probabilistic tiers, and next-turn availability are recalculated for this ${state.settings.teams}-team room.`) + providerMethod + ` The production contract is full PPR; replacement ranks respond to ${state.settings.superflex ? "superflex" : "one-QB"} roster demand${state.settings.tePremium ? ` and a +${state.settings.tePremium} TE premium` : ""}. Recommendations are checked with stochastic rest-of-draft simulations and adaptive opponent beliefs.` + liveMethod;
}

function draftedPlayersForTeam(team) {
  const byId = new Map(dataset.players.map((player) => [player.id, player]));
  return [...state.keepers.filter((keeper) => keeper.team === team), ...state.picks.filter((pick) => pick.team === team)].map((pick) => byId.get(pick.playerId)).filter(Boolean);
}

function countPositions(roster) {
  return roster.reduce((counts, player) => ({ ...counts, [player.position]: (counts[player.position] || 0) + 1 }), {});
}

function recentDraftedPlayers(limit = 5) {
  const byId = new Map(dataset.players.map((player) => [player.id, player]));
  return state.picks.slice(-limit).map((pick) => byId.get(pick.playerId)).filter(Boolean);
}

function leagueStrategyImpact(player, roster, round, team) {
  const slots = state.settings.rosterSlots;
  if (["K", "DST"].includes(player.position) && !slots[player.position]) return -1000;
  let impact = state.settings.superflex && player.position === "QB" ? (countPositions(roster).QB || 0) < 2 ? 30 : 8 : 0;
  if (state.settings.tePremium && player.position === "TE") impact += state.settings.tePremium * 9;
  if (team === state.settings.userSlot) {
    const preset = state.settings.preset;
    if (preset === "hero-rb") impact += player.position === "RB" && !(countPositions(roster).RB) && round < 3 ? 12 : player.position === "WR" && round < 7 ? 4 : 0;
    if (preset === "wr-core" && player.position === "WR" && round < 6) impact += 9;
    if (preset === "robust-rb" && player.position === "RB" && (countPositions(roster).RB || 0) < 2 && round < 5) impact += 10;
    if (preset === "elite-te" && player.position === "TE" && player.tier === 1 && round < 5) impact += 12;
    if (preset === "late-qb" && player.position === "QB" && round < 8 && !state.settings.superflex) impact -= 14;
  }
  return impact;
}

function leagueDraftProfile() {
  const slots = state.settings.rosterSlots;
  return {
    ...OPPONENT_PROFILE,
    targetRoster: {
      QB: slots.QB + slots.SUPERFLEX * .85 + (state.settings.superflex ? .35 : .5),
      RB: slots.RB + slots.FLEX * .5 + slots.BENCH * .34,
      WR: slots.WR + slots.FLEX * .45 + slots.BENCH * .43,
      TE: slots.TE + slots.FLEX * .05 + slots.BENCH * .13,
      K: slots.K,
      DST: slots.DST
    },
    medianFirstRound: { QB: state.settings.superflex ? 2 : 7, TE: state.settings.tePremium ? 5 : 7, K: state.settings.rounds, DST: Math.max(1, state.settings.rounds - 1) }
  };
}

function recommendations(team = pickContext().team) {
  const roster = draftedPlayersForTeam(team);
  const context = pickContext();
  const available = availablePlayers();
  const recentPicks = recentDraftedPlayers();
  const nextPickIndex = nextSelectionForTeam(context.overall - 1, team);
  return available
    .map((player) => {
      const decision = scoreCandidate(player, { roster, round: context.round, currentPickIndex: context.overall - 1, nextPickIndex, availablePlayers: available, profile: leagueDraftProfile(), totalRounds: state.settings.rounds, recentPicks });
      const leagueImpact = leagueStrategyImpact(player, roster, context.round, team);
      return { player, ...decision, score: decision.score + leagueImpact, factors: leagueImpact ? [...decision.factors, { label: "League format", impact: leagueImpact, detail: "PPR roster slots, superflex, TE premium, and the selected draft plan alter positional value." }].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)) : decision.factors };
    })
    .sort((a, b) => b.score - a.score || b.player.vbd - a.player.vbd || a.player.rank - b.player.rank);
}

function allRosters() { return Array.from({ length: state.settings.teams }, (_, team) => draftedPlayersForTeam(team)); }

function monteCarloKey(picks) {
  return `${state.picks.length}|${state.settings.teams}|${state.settings.rounds}|${state.settings.preset}|${picks.slice(0, 3).map((pick) => pick.player.id).join(",")}`;
}

function scheduleMonteCarlo(picks, team) {
  if (isComplete() || !picks.length) return;
  const key = monteCarloKey(picks);
  if (monteCarlo.key === key && (monteCarlo.results || monteCarlo.running)) return;
  monteCarlo = { key, results: null, running: true };
  setTimeout(() => {
    if (monteCarlo.key !== key || isComplete()) return;
    const candidateIds = picks.slice(0, 3).map((pick) => pick.player.id);
    const watchPlayerIds = picks.slice(0, 10).map((pick) => pick.player.id);
    const settings = { ...state.settings, totalDraftPicks: state.settings.teams * state.settings.rounds - state.keepers.length };
    const results = runMonteCarloRestOfDraft({
      candidateIds,
      watchPlayerIds,
      availablePlayers: availablePlayers(),
      rosters: allRosters(),
      currentPickIndex: state.picks.length,
      currentTeam: team,
      settings,
      beliefs: state.opponentBeliefs,
      simulations: 16,
      seed: Date.now() + state.picks.length * 104729
    });
    if (monteCarlo.key === key) { monteCarlo = { key, results, running: false }; renderRecommendation(); }
  }, 0);
}

function renderScarcity() {
  const available = availablePlayers();
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
  elements.scarcityPanel.innerHTML = positions.map((position) => {
    const pool = available.filter((player) => player.position === position).sort((a, b) => b.projection - a.projection);
    const top = pool[0];
    const tierLeft = top ? pool.filter((player) => player.tier === top.tier).length : 0;
    const pressure = top ? Math.min(100, Math.max(5, (top.tierDropoff || 0) * 7 + (tierLeft <= 2 ? 38 : 8))) : 0;
    return `<article class="scarcity-item ${pressure >= 60 ? "hot" : ""}"><header><span>${position}</span><strong>${tierLeft} in tier</strong></header><div class="scarcity-track"><i style="width:${pressure}%"></i></div></article>`;
  }).join("");
}

function slotRoster(players) {
  const configured = state.settings.rosterSlots;
  const slots = [
    ...["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DST"].flatMap((position) => Array.from({ length: configured[position] || 0 }, () => position)),
    ...Array.from({ length: configured.BENCH || 0 }, (_, index) => `BN${index + 1}`)
  ];
  const assigned = slots.map((slot) => ({ slot, player: null }));
  for (const player of players) {
    let target = assigned.find((entry) => !entry.player && entry.slot === player.position);
    if (!target && ["RB", "WR", "TE"].includes(player.position)) target = assigned.find((entry) => !entry.player && entry.slot === "FLEX");
    if (!target && ["QB", "RB", "WR", "TE"].includes(player.position)) target = assigned.find((entry) => !entry.player && entry.slot === "SUPERFLEX");
    if (!target) target = assigned.find((entry) => !entry.player && entry.slot.startsWith("BN"));
    if (target) target.player = player;
  }
  return assigned;
}

function rosterGrade(players) {
  if (!players.length) return "—";
  const leagueRosters = Array.from({ length: state.settings.teams }, (_, team) => draftedPlayersForTeam(team));
  const scores = leagueRosters.map((roster) => evaluateRoster(roster, state.settings, leagueRosters).score);
  const score = evaluateRoster(players, state.settings, leagueRosters).score;
  const rank = [...scores].sort((a, b) => b - a).indexOf(score);
  const percentile = scores.length > 1 ? 1 - rank / (scores.length - 1) : .5;
  return percentile >= .9 ? "A" : percentile >= .72 ? "A−" : percentile >= .55 ? "B+" : percentile >= .38 ? "B" : percentile >= .2 ? "C+" : "C";
}

function rosterQuality(players) {
  if (!players.length) return -1000;
  const leagueRosters = Array.from({ length: state.settings.teams }, (_, team) => draftedPlayersForTeam(team));
  return evaluateRoster(players, state.settings, leagueRosters).score;
}

function renderFilters() {
  elements.positionFilters.innerHTML = POSITIONS.map((position) => `<button class="filter-button ${position === activePosition ? "active" : ""}" type="button" data-position="${position}">${position}</button>`).join("");
}

function suggestedAuctionPrice(player) {
  if (Number.isFinite(player.auctionValue)) return Math.max(1, Math.round(player.auctionValue));
  const budget = state.settings.auctionBudget || 200;
  const scarcity = Math.max(0, player.vbd || 0);
  return Math.max(1, Math.min(Math.round(budget * .36), Math.round(1 + scarcity * budget / 520)));
}

function renderBoard() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const players = availablePlayers().filter((player) => {
    const matchesPosition = activePosition === "ALL" || player.position === activePosition || (activePosition === "FLEX" && ["RB", "WR", "TE"].includes(player.position));
    return matchesPosition && (!query || `${player.name} ${player.team} ${player.position}`.toLowerCase().includes(query));
  });
  elements.poolCount.textContent = availablePlayers().length.toLocaleString();
  const context = pickContext();
  const team = context.team;
  const nextPickIndex = nextSelectionForTeam(context.overall - 1, team);
  const roster = draftedPlayersForTeam(team);
  const available = availablePlayers();
  const recentPicks = recentDraftedPlayers();
  elements.playerRows.innerHTML = players.slice(0, 50).map((player) => {
    const decision = scoreCandidate(player, { roster, round: context.round, currentPickIndex: context.overall - 1, nextPickIndex, availablePlayers: available, profile: leagueDraftProfile(), totalRounds: state.settings.rounds, recentPicks });
    const trend = player.trendingAdds > player.trendingDrops && player.trendingAdds >= 5 ? `↑ ${player.trendingAdds} adds` : null;
    const signal = player.injury || trend || `T${player.tier} · ${decision.hasNextPick ? `${Math.round(decision.availability * 100)}% next` : "final turn"}`;
    const lowRisk = Number.isFinite(player.uncertainty) && player.uncertainty <= (player.uncertainty <= 1 ? .33 : 33);
    return `<tr>
      <td class="rank-cell">${player.rank}</td>
      <td class="player-name"><strong>${escapeHtml(player.name)}</strong><small>${player.team} · ${player.yearsExperience ?? "—"} yr exp</small></td>
      <td><span class="pos-badge pos-${player.position}">${player.position}</span></td>
      <td class="metric">${player.projection.toFixed(1)}</td>
      <td class="metric ${player.vbd > 0 ? "vbd-positive" : ""}">${player.vbd > 0 ? "+" : ""}${player.vbd.toFixed(1)}</td>
      <td class="signal ${player.injury ? "warn" : lowRisk ? "low-risk" : ""}">${escapeHtml(signal)}</td>
      <td><div class="row-actions"><button class="compare-pick ${comparisonSelection.has(player.id) ? "selected" : ""}" type="button" data-compare="${player.id}" aria-label="Compare ${escapeHtml(player.name)}">±</button><button class="draft-button" type="button" data-draft="${player.id}" ${isComplete() || isSimulating ? "disabled" : ""}>${state.settings.draftFormat === "auction" ? `$${suggestedAuctionPrice(player)}` : "Draft"}</button></div></td>
    </tr>`;
  }).join("") || `<tr><td class="empty-row" colspan="7">No available players match this filter.</td></tr>`;
  elements.compareCount.textContent = comparisonSelection.size;
  elements.compareButton.disabled = comparisonSelection.size < 2;
}

function renderClock() {
  if (isComplete()) {
    elements.clockTeam.textContent = "Draft complete";
    elements.roundLabel.textContent = `${state.settings.rounds} rounds`;
    elements.pickLabel.textContent = `${state.picks.length + state.keepers.length} roster slots filled`;
    elements.clockTrack.innerHTML = "";
    elements.simulateButton.disabled = true;
    elements.fullSimButton.disabled = true;
    elements.fullSimButton.textContent = "Draft Complete";
    return;
  }
  const context = pickContext();
  elements.clockTeam.textContent = teamName(context.team);
  elements.roundLabel.textContent = state.settings.draftFormat === "auction" ? `Nomination ${context.overall}` : `Round ${context.round + 1}`;
  elements.pickLabel.textContent = `Pick ${context.round + 1}.${String(context.offset + 1).padStart(2, "0")} · #${context.overall}`;
  elements.clockTrack.innerHTML = Array.from({ length: state.settings.teams }, (_, index) => `<span class="clock-dot ${index < context.offset ? "done" : index === context.offset ? "current" : ""}"></span>`).join("");
  elements.simulateButton.disabled = isSimulating || context.team === state.settings.userSlot;
  elements.simulateButton.textContent = context.team === state.settings.userSlot ? "Your Pick Is Ready" : "Run to My Pick";
  elements.fullSimButton.disabled = false;
  elements.fullSimButton.textContent = isSimulating ? "Pause Simulation" : state.settings.draftFormat === "auction" ? "Simulate Auction" : "Simulate Full Draft";
}

function renderRecommendation() {
  if (isComplete()) {
    elements.recommendationCard.innerHTML = `<h2>Board Closed</h2><p class="rec-reason">The draft is complete. Compare every roster, grade the room, or start a new draft.</p><button class="button button-gold" type="button" data-open-results>View League Results</button>`;
    elements.alternatives.innerHTML = "";
    elements.confidence.textContent = "Final";
    return;
  }
  const context = pickContext();
  const basePicks = recommendations(context.team);
  const key = monteCarloKey(basePicks);
  const hasSimulation = monteCarlo.key === key && monteCarlo.results;
  const simulatedLeaders = hasSimulation ? basePicks.slice(0, 3).sort((a, b) => (monteCarlo.results[b.player.id]?.expectedRosterScore || 0) - (monteCarlo.results[a.player.id]?.expectedRosterScore || 0)) : basePicks.slice(0, 3);
  const leaderIds = new Set(simulatedLeaders.map((pick) => pick.player.id));
  const picks = [...simulatedLeaders, ...basePicks.filter((pick) => !leaderIds.has(pick.player.id))];
  const bestPick = picks[0];
  const best = bestPick?.player;
  if (!best) return;
  const gap = picks[0].score - (picks[1]?.score ?? picks[0].score);
  elements.confidence.textContent = gap > 15 ? "Strong edge" : gap > 6 ? "Clear lean" : "Close call";
  const consensusMeta = best.modelSource === "multi-provider" ? `${Object.keys(best.providerSources || {}).map((source) => source === "fantasypros" ? "FANTASYPROS" : "SPORTSDATAIO").join(" + ")} CONSENSUS${best.providerDisagreement ? ` · ±${(best.providerDisagreement / 2).toFixed(1)}` : ""}` : best.modelSource === "ffanalytics" ? `${best.projectionMethod?.toUpperCase() || "FFA"} CONSENSUS${best.consensusTier ? ` · SOURCE TIER ${best.consensusTier}` : ""}` : best.depthOrder === 1 ? "PROJECTED STARTER" : "ACTIVE ROSTER";
  const factorRows = bestPick.factors.slice(0, 4).map((factor) => `<li><span>${escapeHtml(factor.label)}</span><strong class="${factor.impact >= 0 ? "positive" : "negative"}">${factor.impact >= 0 ? "+" : ""}${factor.impact.toFixed(1)}</strong><small>${escapeHtml(factor.detail)}</small></li>`).join("");
  const mc = hasSimulation ? monteCarlo.results[best.id] : null;
  const survivalRows = mc ? picks.slice(1, 5).map(({ player }) => {
    const survival = mc.survival[player.id] ?? 0;
    return `<div class="availability-bar"><span>${escapeHtml(player.lastName || player.name)}</span><i style="width:${Math.round(survival * 100)}%"></i><strong>${Math.round(survival * 100)}%</strong></div>`;
  }).join("") : "";
  const mcSummary = mc ? `<section class="mc-summary"><header><span>Monte Carlo rest-of-draft</span><strong>${mc.simulations} paths</strong></header><div class="mc-grid"><div><span>Expected lineup</span><strong>${mc.expectedWeekly.toFixed(1)}/wk</strong></div><div><span>Expected wins</span><strong>${Math.round(mc.expectedWinRate * 100)}%</strong></div><div><span>80% range</span><strong>${mc.downsideWeekly.toFixed(1)}–${mc.upsideWeekly.toFixed(1)}</strong></div></div><div class="availability-bars">${survivalRows}</div></section>` : `<section class="mc-summary"><header><span>Monte Carlo rest-of-draft</span><strong>${monteCarlo.running ? "Running…" : "Queued"}</strong></header></section>`;
  elements.recommendationCard.innerHTML = `
    <div class="rec-topline"><span class="pos-badge pos-${best.position}">${best.position}</span><span class="rec-rank">BOARD #${best.rank}</span></div>
    <h2 id="recommendationTitle">${escapeHtml(best.name)}</h2>
    <div class="rec-meta">${best.team} · ${consensusMeta}</div>
    <p class="rec-reason">${mc ? "Best expected completed PPR roster across simulated draft paths, with" : "Best research-adjusted combination of"} value, ${bestPick.phase.toLowerCase()} utility, roster feasibility, tier urgency, and wait risk.</p>
    <div class="rec-metrics"><div><span>Est. points</span><strong>${best.projection.toFixed(1)}</strong></div><div><span>Dynamic VBD</span><strong>${best.vbd > 0 ? "+" : ""}${best.vbd.toFixed(1)}</strong></div><div><span>Reliability</span><strong>${Math.round(bestPick.reliability * 100)}%</strong></div><div><span>Chance at next pick</span><strong>${bestPick.hasNextPick ? `${Math.round(bestPick.availability * 100)}%` : "No next turn"}</strong></div></div>
    ${mcSummary}
    <div class="factor-heading">Why the model likes this pick</div><ul class="factor-list">${factorRows}</ul>
    <div class="rec-actions"><button class="button button-quiet" type="button" data-what-if="${best.id}">What if?</button><button class="button button-gold" type="button" data-draft="${best.id}">${state.settings.draftFormat === "auction" ? `Bid $${suggestedAuctionPrice(best)}` : `Draft ${escapeHtml(best.lastName || best.name)}`}</button></div>
    <div class="feedback-buttons"><button type="button" data-feedback="agree" data-player="${best.id}">Recommendation makes sense</button><button type="button" data-feedback="disagree" data-player="${best.id}">I prefer someone else</button></div>`;
  elements.alternatives.innerHTML = picks.slice(1, 4).map(({ player }, index) => `<div class="alternative"><em>0${index + 2}</em><strong>${escapeHtml(player.name)}</strong><span class="pos-badge pos-${player.position}">${player.position}</span></div>`).join("");
  scheduleMonteCarlo(basePicks, context.team);
}

function renderRoster() {
  const team = state.settings.userSlot;
  const players = draftedPlayersForTeam(team);
  const counts = countPositions(players);
  const evaluation = evaluateRoster(players, state.settings, allRosters());
  elements.rosterTitle.textContent = `Team ${team + 1} roster`;
  elements.rosterGrade.textContent = rosterGrade(players);
  const slots = state.settings.rosterSlots;
  const needs = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DST"].filter((position) => slots[position] > 0).map((position) => ({ p: position, n: slots[position] }));
  const skillExtra = Math.max(0, (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0) - slots.RB - slots.WR - slots.TE);
  elements.needsStrip.innerHTML = needs.map(({ p, n }) => {
    const filled = p === "FLEX" ? Math.min(n, skillExtra) : p === "SUPERFLEX" ? Math.min(n, Math.max(0, (counts.QB || 0) - slots.QB) + skillExtra) : Math.min(n, counts[p] || 0);
    return `<span class="need-chip ${filled >= n ? "filled" : "open"}">${p} ${filled}/${n}</span>`;
  }).join("");
  const matchupEdge = players.length ? `${Math.round(evaluation.expectedWins * 100)}% matchup edge` : "Matchup edge pending";
  elements.rosterList.innerHTML = `<div class="roster-row"><span class="slot">PPR</span><strong>${evaluation.weekly.toFixed(1)} projected / week</strong><small>${matchupEdge}</small></div>` + slotRoster(players).map(({ slot, player }) => `<div class="roster-row"><span class="slot">${slot}</span>${player ? `<strong>${escapeHtml(player.name)}</strong><small>${player.team} · ${player.position}${player.byeWeek ? ` · BYE ${player.byeWeek}` : ""}</small>` : `<span class="empty">Open slot</span><small>—</small>`}</div>`).join("");
}

function renderHistory() {
  const byId = new Map(dataset.players.map((player) => [player.id, player]));
  const recent = state.picks.slice(-8).reverse();
  elements.historyList.innerHTML = recent.map((pick) => {
    const player = byId.get(pick.playerId);
    return `<div class="history-row"><span>#${pick.index + 1}</span><strong>${escapeHtml(player?.name || "Unknown player")}${pick.price ? ` · $${pick.price}` : ""}</strong><small>${teamName(pick.team)}</small></div>`;
  }).join("") || `<div class="history-empty">No picks yet. The board is yours.</div>`;
  elements.undoButton.disabled = !state.picks.length || isSimulating;
}

function renderLeagueResults() {
  const leagueRosters = allRosters();
  const teamRows = Array.from({ length: state.settings.teams }, (_, team) => {
    const players = draftedPlayersForTeam(team);
    const evaluation = evaluateRoster(players, state.settings, leagueRosters);
    return { team, players, score: evaluation.score, grade: rosterGrade(players), evaluation };
  }).sort((a, b) => b.score - a.score).map((row, index, rows) => ({ ...row, roomPercentile: rows.length > 1 ? (1 - index / (rows.length - 1)) * 100 : 50 }));
  const leader = teamRows[0];
  elements.leagueSummary.textContent = state.picks.length
    ? `${state.picks.length + state.keepers.length} of ${state.settings.teams * state.settings.rounds} roster slots filled in this PPR room. ${teamName(leader.team)} currently leads the room.`
    : "Team grades update after every pick and compare value, projected output, and roster coverage.";
  const userRow = teamRows.find((row) => row.team === state.settings.userSlot);
  const calibration = historicalCalibration(userRow?.score, draftHistory, { ...state.settings, gradeVersion: GRADE_MODEL_VERSION }, state.draftId);
  const providerGradeSets = Object.fromEntries([...providerSummary.usableProviders, ...(providerSummary.usableProviders.length ? ["consensus"] : [])].map((provider) => [provider, new Map(providerRosterGrades(leagueRosters, state.settings, provider).map((grade) => [grade.team, grade]))]));
  const providerLabels = { fantasypros: "FantasyPros", sportsdataio: "SportsDataIO", consensus: "Provider consensus" };
  const providerStatus = ["fantasypros", "sportsdataio"].map((provider) => `${providerLabels[provider]}: ${providerSnapshot?.providers?.[provider]?.status || "not-configured"} · ${providerSnapshot?.providers?.[provider]?.matches || 0} matched`).join(" · ");
  elements.providerAudit.innerHTML = `<strong>Independent provider grading</strong><span>${escapeHtml(providerStatus)}. Provider projections are blended into recommendations at ${Math.round(learningProfile.providerInfluence * 100)}% influence when both sources cover a player.</span><span>Learning: ${learningProfile.completedDrafts} qualifying drafts · provider regret EMA ${learningProfile.regretEma == null ? "pending" : `${learningProfile.regretEma.toFixed(1)} points`}. Updates are bounded and require dual-provider coverage.</span>`;
  if (calibration.sampleSize) elements.providerAudit.innerHTML += `<span>Your raw roster score is at the ${Math.round(calibration.percentile * 100)}th percentile across ${calibration.sampleSize} prior completed drafts with matching settings. Historical comparison is context, not ground truth.</span>`;
  elements.leagueGrid.innerHTML = teamRows.map(({ team, players, grade, evaluation, roomPercentile }, index) => {
    const counts = countPositions(players);
    const style = dominantOpponentStyle(state.opponentBeliefs[team]);
    const spent = state.picks.filter((pick) => pick.team === team).reduce((sum, pick) => sum + (pick.price || 0), 0);
    const budgetLine = state.settings.draftFormat === "auction" ? `<span>$${spent} spent · $${state.settings.auctionBudget - spent} left</span>` : "";
    const providerLines = Object.entries(providerGradeSets).map(([provider, grades]) => {
      const providerGrade = grades.get(team);
      const disagreement = providerGrade ? Math.abs(providerGrade.rank - (index + 1)) >= Math.max(2, Math.floor(state.settings.teams * .25)) : false;
      return providerGrade ? `<span class="external-score ${disagreement ? "disagrees" : ""}">${providerLabels[provider]} ${escapeHtml(providerGrade.grade)} · ${providerGrade.weekly.toFixed(1)}/wk · ${providerGrade.coveredPlayers}/${players.length || 0} covered${disagreement ? " · rank disagreement" : ""}</span>` : "";
    }).join("");
    const explanation = evaluation.explanations.slice(0, 4).map((item) => `<span><strong>${escapeHtml(item.label)}</strong><br>${escapeHtml(item.value)}</span>`).join("");
    return `<article class="team-card ${team === state.settings.userSlot ? "is-user" : ""}">
      <header><div><span>${index === 0 && players.length ? "ROOM LEADER" : `DRAFT SLOT ${team + 1}`} · ${team === state.settings.userSlot ? "RECOMMENDATION MODEL" : `${escapeHtml(style.name.toUpperCase())} ${Math.round(style.confidence * 100)}%`}</span><h3>${escapeHtml(teamName(team))}</h3></div><strong>${grade}</strong></header>
      <div class="team-card-stats"><span>${players.length} players</span><span>${evaluation.weekly.toFixed(1)} PPR/wk</span><span>${Math.round(evaluation.expectedWins * 100)}% expected wins</span>${budgetLine}${providerLines}<span>QB ${counts.QB || 0} · RB ${counts.RB || 0} · WR ${counts.WR || 0} · TE ${counts.TE || 0}</span></div>
      <div class="grade-explain">${explanation}</div>
      <ol>${players.map((player) => `<li><span class="pos-badge pos-${player.position}">${player.position}</span><strong>${escapeHtml(player.name)}</strong><small>${player.team}</small></li>`).join("") || "<li class=\"team-empty\">No picks yet.</li>"}</ol>
    </article>`;
  }).join("");
}

function renderAll() {
  renderFilters();
  renderClock();
  renderScarcity();
  renderBoard();
  renderRecommendation();
  renderRoster();
  renderHistory();
  if (elements.leagueDialog.open) renderLeagueResults();
}

function draftPlayer(playerId, isAuto = false) {
  if (isComplete() || state.picks.some((pick) => pick.playerId === playerId)) return;
  const context = pickContext();
  const player = dataset.players.find((candidate) => candidate.id === playerId);
  const rosterBefore = draftedPlayersForTeam(context.team);
  state.opponentBeliefs[context.team] = updateOpponentBelief(state.opponentBeliefs[context.team], { player, rosterBefore, round: context.round, pickNumber: context.overall, recentPicks: recentDraftedPlayers() });
  const price = state.settings.draftFormat === "auction" ? suggestedAuctionPrice(player) : null;
  state.picks.push({ playerId, team: context.team, index: context.overall - 1, price });
  state.cursor = nextOpenDraftIndex(context.overall);
  monteCarlo = { key: null, results: null, running: false };
  saveState();
  renderAll();
  if (!isAuto) {
    showToast(`${player.name} ${price ? `won for $${price}` : "drafted"} by ${teamName(context.team)}`);
    if (state.settings.autoOpponents && !isComplete()) setTimeout(runToUserPick, 180);
  }
  if (isComplete() || state.picks.length % state.settings.teams === 0) void logCurrentDraft(isComplete() ? "complete" : "in-progress");
}

function autoPick() {
  const context = pickContext();
  const roster = draftedPlayersForTeam(context.team);
  const recentPicks = recentDraftedPlayers();
  const spent = state.picks.filter((pick) => pick.team === context.team).reduce((sum, pick) => sum + (pick.price || 0), 0);
  const remainingBudget = state.settings.auctionBudget - spent;
  const choices = recommendations(context.team).filter(({ player }) => state.settings.draftFormat !== "auction" || suggestedAuctionPrice(player) <= remainingBudget).slice(0, 20);
  if (!choices.length) return;
  const ranked = choices.map((choice) => {
    const adaptiveBias = expectedOpponentBias(state.opponentBeliefs[context.team], choice.player, roster, context.round);
    const hash = [...String(choice.player.id)].reduce((value, character) => (value * 31 + character.charCodeAt(0)) % 997, state.simulationSeed + state.picks.length * 19 + context.team * 17);
    const stableVariation = (hash / 997 - .5) * 3;
    return { ...choice, opponentScore: choice.score + adaptiveBias + stableVariation };
  }).sort((a, b) => b.opponentScore - a.opponentScore || b.score - a.score);
  draftPlayer(ranked[0].player.id, true);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runSimulation({ stopAtUser }) {
  if (isSimulating) return;
  const nonce = ++simulationNonce;
  isSimulating = true;
  renderAll();
  const pace = Number(state.settings.simulationPace) || 0;
  while (!isComplete() && nonce === simulationNonce) {
    if (stopAtUser && pickContext().team === state.settings.userSlot) break;
    autoPick();
    if (pace) await wait(pace);
    else if (state.picks.length % state.settings.teams === 0) await wait(0);
  }
  if (nonce !== simulationNonce) return;
  isSimulating = false;
  saveState();
  renderAll();
  showToast(isComplete() ? "Full draft simulated" : "Your pick is ready");
}

function runToUserPick() { return runSimulation({ stopAtUser: true }); }
function simulateFullDraft() {
  if (isSimulating) {
    simulationNonce++;
    isSimulating = false;
    renderAll();
    showToast("Simulation paused");
    return;
  }
  return runSimulation({ stopAtUser: false });
}

function undo() {
  if (!state.picks.length) return;
  if (state.settings.autoOpponents) {
    let index = state.picks.length - 1;
    while (index >= 0 && state.picks[index].team !== state.settings.userSlot) index--;
    state.picks.splice(Math.max(0, index));
  } else {
    state.picks.pop();
  }
  state.cursor = state.picks.length ? nextOpenDraftIndex(state.picks[state.picks.length - 1].index + 1) : 0;
  rebuildOpponentBeliefs();
  monteCarlo = { key: null, results: null, running: false };
  saveState();
  renderAll();
  showToast("Last selection undone");
}

function rebuildOpponentBeliefs() {
  const beliefs = createOpponentBeliefs(state.settings.teams, state.settings.userSlot);
  const rosters = Array.from({ length: state.settings.teams }, (_, team) => state.keepers.filter((keeper) => keeper.team === team).map((keeper) => dataset.players.find((player) => player.id === keeper.playerId)).filter(Boolean));
  const recent = [];
  for (const pick of state.picks) {
    const player = dataset.players.find((candidate) => candidate.id === pick.playerId);
    if (!player) continue;
    const round = Math.floor(pick.index / state.settings.teams);
    beliefs[pick.team] = updateOpponentBelief(beliefs[pick.team], { player, rosterBefore: rosters[pick.team], round, pickNumber: pick.index + 1, recentPicks: recent.slice(-5) });
    rosters[pick.team].push(player);
    recent.push(player);
  }
  state.opponentBeliefs = beliefs;
}

function populateSlots(selected = state.settings.userSlot) {
  const teams = Number(elements.teamCount.value || state.settings.teams);
  elements.userSlot.innerHTML = Array.from({ length: teams }, (_, index) => `<option value="${index}" ${index === Math.min(selected, teams - 1) ? "selected" : ""}>Pick ${index + 1}</option>`).join("");
}

function rosterSlotsFromForm() {
  return { QB: Number(elements.slotQB.value), RB: Number(elements.slotRB.value), WR: Number(elements.slotWR.value), TE: Number(elements.slotTE.value), FLEX: Number(elements.slotFlex.value), SUPERFLEX: Number(elements.slotSuperflex.value), K: Number(elements.slotK.value), DST: Number(elements.slotDST.value) };
}

function setRosterSlotFields(slots) {
  elements.slotQB.value = slots.QB ?? 1; elements.slotRB.value = slots.RB ?? 2; elements.slotWR.value = slots.WR ?? 2; elements.slotTE.value = slots.TE ?? 1;
  elements.slotFlex.value = slots.FLEX ?? 2; elements.slotSuperflex.value = slots.SUPERFLEX ?? 0; elements.slotK.value = slots.K ?? 1; elements.slotDST.value = slots.DST ?? 1;
}

function parseManualKeepers(text) {
  const byName = new Map(dataset.players.map((player) => [normalizedName(player.name), player]));
  const keepers = [];
  const usedPlayers = new Set();
  for (const line of String(text || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^Team\s+(\d+)\s*:\s*(.+)$/i);
    if (!match) continue;
    const team = Number(match[1]) - 1;
    const rawPlayer = match[2].trim();
    const player = dataset.players.find((item) => item.id === rawPlayer) || byName.get(normalizedName(rawPlayer));
    if (player && team >= 0 && team < Number(elements.teamCount.value) && !usedPlayers.has(player.id)) {
      keepers.push({ playerId: player.id, team, keeper: true });
      usedPlayers.add(player.id);
    }
  }
  return keepers;
}

function parseTradedPicks(text) {
  const traded = {};
  const teams = Number(elements.teamCount.value);
  const maxPicks = teams * Number(elements.rounds.value);
  for (const line of String(text || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^(\d+)\s*:\s*Team\s+(\d+)$/i);
    if (!match) continue;
    const overall = Number(match[1]);
    const team = Number(match[2]) - 1;
    if (overall >= 1 && overall <= maxPicks && team >= 0 && team < teams) traded[overall] = team;
  }
  return traded;
}

async function importSleeperLeague() {
  const leagueId = elements.sleeperLeagueId.value.trim();
  if (!/^\d+$/.test(leagueId)) { elements.sleeperImportStatus.textContent = "Enter a numeric Sleeper league ID."; return; }
  elements.importSleeperButton.disabled = true;
  elements.sleeperImportStatus.textContent = "Loading public Sleeper league configuration…";
  try {
    const leagueResponse = await fetch(`https://api.sleeper.app/v1/league/${leagueId}`);
    if (!leagueResponse.ok) throw new Error(`League returned ${leagueResponse.status}`);
    const league = await leagueResponse.json();
    const draftsResponse = await fetch(`https://api.sleeper.app/v1/league/${leagueId}/drafts`);
    const drafts = draftsResponse.ok ? await draftsResponse.json() : [];
    const draft = drafts[0] || null;
    const teams = Number(league.total_rosters || draft?.settings?.teams || 10);
    if (![...elements.teamCount.options].some((option) => Number(option.value) === teams)) elements.teamCount.add(new Option(String(teams), String(teams)));
    elements.teamCount.value = String(teams);
    const positionMap = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "FLEX", WRRB_FLEX: "FLEX", REC_FLEX: "FLEX", SUPER_FLEX: "SUPERFLEX", K: "K", DEF: "DST" };
    const slots = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPERFLEX: 0, K: 0, DST: 0 };
    for (const position of league.roster_positions || []) if (positionMap[position]) slots[positionMap[position]]++;
    setRosterSlotFields(slots);
    const rounds = Number(draft?.settings?.rounds || (league.roster_positions || []).length || 15);
    if (![...elements.roundCount.options].some((option) => Number(option.value) === rounds)) elements.roundCount.add(new Option(String(rounds), String(rounds)));
    elements.roundCount.value = String(rounds);
    elements.draftFormat.value = draft?.type === "auction" ? "auction" : "snake";
    elements.tePremium.value = Number(league.scoring_settings?.bonus_rec_te || 0) >= 1 ? "1" : Number(league.scoring_settings?.bonus_rec_te || 0) >= .5 ? "0.5" : "0";
    populateSlots(Math.min(state.settings.userSlot, teams - 1));
    let keeperLines = [];
    let tradedLines = [];
    if (draft?.draft_id) {
      const [picksResponse, tradedResponse] = await Promise.all([fetch(`https://api.sleeper.app/v1/draft/${draft.draft_id}/picks`), fetch(`https://api.sleeper.app/v1/draft/${draft.draft_id}/traded_picks`)]);
      const picks = picksResponse.ok ? await picksResponse.json() : [];
      const traded = tradedResponse.ok ? await tradedResponse.json() : [];
      const slotByRoster = new Map(Object.entries(draft.slot_to_roster_id || {}).map(([slot, roster]) => [Number(roster), Number(slot)]));
      keeperLines = picks.filter((pick) => pick.is_keeper).map((pick) => `Team ${slotByRoster.get(Number(pick.roster_id)) || pick.draft_slot}: ${dataset.players.find((player) => player.id === String(pick.player_id))?.name || pick.player_id}`);
      tradedLines = traded.map((pick) => {
        const originalSlot = slotByRoster.get(Number(pick.roster_id));
        const ownerSlot = slotByRoster.get(Number(pick.owner_id));
        if (!originalSlot || !ownerSlot) return null;
        const round = Number(pick.round);
        const offset = round % 2 === 1 ? originalSlot : teams - originalSlot + 1;
        return `${(round - 1) * teams + offset}: Team ${ownerSlot}`;
      }).filter(Boolean);
    }
    elements.keepersInput.value = keeperLines.join("\n");
    elements.tradedPicksInput.value = tradedLines.join("\n");
    state.leagueImport = { leagueId, name: league.name || "Sleeper league", importedAt: new Date().toISOString(), originalReceptionScoring: league.scoring_settings?.rec ?? null };
    const scoringNote = Number(league.scoring_settings?.rec) === 1 ? "PPR scoring confirmed" : "source scoring noted; production model remains locked to PPR";
    elements.sleeperImportStatus.textContent = `${league.name || "League"}: ${teams} teams · ${rounds} rounds · ${keeperLines.length} keepers · ${tradedLines.length} traded picks · ${scoringNote}.`;
  } catch (error) { elements.sleeperImportStatus.textContent = `Sleeper import failed: ${error.message}`; }
  finally { elements.importSleeperButton.disabled = false; }
}

function openSetup() {
  simulationNonce++;
  isSimulating = false;
  elements.teamCount.value = state.settings.teams;
  elements.roundCount.value = state.settings.rounds;
  elements.autoOpponents.checked = state.settings.autoOpponents;
  elements.simulationPace.value = String(state.settings.simulationPace);
  elements.draftPreset.value = state.settings.preset || "balanced";
  elements.draftFormat.value = state.settings.draftFormat || "snake";
  elements.tePremium.value = String(state.settings.tePremium || 0);
  elements.auctionBudget.value = state.settings.auctionBudget || 200;
  elements.sleeperLeagueId.value = state.leagueImport?.leagueId || "";
  elements.keepersInput.value = state.keepers.map((keeper) => `Team ${keeper.team + 1}: ${dataset.players.find((player) => player.id === keeper.playerId)?.name || keeper.playerId}`).join("\n");
  elements.tradedPicksInput.value = Object.entries(state.tradedPicks).map(([pick, team]) => `${pick}: Team ${team + 1}`).join("\n");
  setRosterSlotFields(state.settings.rosterSlots);
  populateSlots();
  recalculateModel();
  elements.setupDialog.showModal();
}

async function startNewDraft(event) {
  event.preventDefault();
  simulationNonce++;
  isSimulating = false;
  await logCurrentDraft(isComplete() ? "complete" : "abandoned");
  const settings = normalizeLeagueSettings({
      teams: Number(elements.teamCount.value),
      userSlot: Number(elements.userSlot.value),
      rounds: Number(elements.roundCount.value),
      autoOpponents: elements.autoOpponents.checked,
      simulationPace: Number(elements.simulationPace.value),
      rosterSlots: rosterSlotsFromForm(),
      tePremium: Number(elements.tePremium.value),
      draftFormat: elements.draftFormat.value,
      auctionBudget: Number(elements.auctionBudget.value),
      preset: elements.draftPreset.value
  });
  state = {
    version: 3,
    draftId: createDraftId(),
    startedAt: new Date().toISOString(),
    settings,
    picks: [],
    cursor: 0,
    keepers: parseManualKeepers(elements.keepersInput.value),
    tradedPicks: parseTradedPicks(elements.tradedPicksInput.value),
    model: state.model,
    opponentBeliefs: createOpponentBeliefs(settings.teams, settings.userSlot),
    feedback: [],
    leagueImport: state.leagueImport,
    simulationSeed: Math.floor(Math.random() * 2 ** 31)
  };
  comparisonSelection.clear();
  monteCarlo = { key: null, results: null, running: false };
  recalculateModel();
  saveState();
  elements.setupDialog.close();
  renderAll();
  showToast("New draft room started");
  if (state.settings.autoOpponents && state.settings.userSlot > 0) setTimeout(runToUserPick, 250);
}

function modelFromProjectionText(text, fileName) {
  const result = buildProjectionDataset(parseCsv(text), dataset.players);
  if (!result.matches) throw new Error("No players matched. Export player names with add_player_info() before creating the CSV.");
  return { source: "ffanalytics", fileName, importedAt: new Date().toISOString(), ...result };
}

async function importProjections(file) {
  state.model = modelFromProjectionText(await file.text(), file.name);
  recalculateModel();
  saveState();
  renderAll();
  showToast(`${state.model.matches} ffanalytics projections loaded`);
}

function clearProjectionModel() {
  state.model = null;
  recalculateModel();
  saveState();
  renderAll();
  showToast("Registry estimates restored");
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

document.addEventListener("click", (event) => {
  const draftButton = event.target.closest("[data-draft]");
  if (draftButton) draftPlayer(draftButton.dataset.draft);
  const filterButton = event.target.closest("[data-position]");
  if (filterButton) { activePosition = filterButton.dataset.position; syncBoardUrl(); renderFilters(); renderBoard(); }
  const comparePick = event.target.closest("[data-compare]");
  if (comparePick) toggleComparison(comparePick.dataset.compare);
  const whatIf = event.target.closest("[data-what-if]");
  if (whatIf) openComparison([whatIf.dataset.whatIf]);
  const feedback = event.target.closest("[data-feedback]");
  if (feedback) recordRecommendationFeedback(feedback.dataset.feedback, feedback.dataset.player);
  if (event.target.closest("[data-open-results]")) openLeagueResults();
  if (event.target.closest("[data-export-ledger]")) void exportDraftLedger();
});
function syncBoardUrl() {
  const url = new URL(location.href);
  if (activePosition === "ALL") url.searchParams.delete("pos"); else url.searchParams.set("pos", activePosition);
  const query = elements.searchInput.value.trim();
  if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}
function openLeagueResults() { renderLeagueResults(); elements.leagueDialog.showModal(); void logCurrentDraft(isComplete() ? "complete" : "in-progress"); }

function toggleComparison(playerId) {
  if (comparisonSelection.has(playerId)) comparisonSelection.delete(playerId);
  else {
    if (comparisonSelection.size >= 2) comparisonSelection.delete(comparisonSelection.values().next().value);
    comparisonSelection.add(playerId);
  }
  renderBoard();
}

function openComparison(playerIds = [...comparisonSelection]) {
  const team = state.settings.userSlot;
  const roster = draftedPlayersForTeam(team);
  const picks = recommendations(pickContext().team);
  const decisionById = new Map(picks.map((pick) => [pick.player.id, pick]));
  const cards = playerIds.map((id) => {
    const player = dataset.players.find((candidate) => candidate.id === id);
    if (!player) return "";
    const decision = decisionById.get(id);
    const before = evaluateRoster(roster, state.settings, allRosters());
    const after = evaluateRoster([...roster, player], state.settings, allRosters().map((teamRoster, index) => index === team ? [...teamRoster, player] : teamRoster));
    const mc = monteCarlo.results?.[id];
    return `<article class="comparison-card"><span class="pos-badge pos-${player.position}">${player.position}</span><h3>${escapeHtml(player.name)}</h3><small>${player.team} · Tier ${player.tier}${player.byeWeek ? ` · Bye ${player.byeWeek}` : ""}</small><div class="comparison-metrics"><div><span>Projection</span><strong>${player.projection.toFixed(1)}</strong></div><div><span>VBD</span><strong>${player.vbd >= 0 ? "+" : ""}${player.vbd.toFixed(1)}</strong></div><div><span>Next-pick chance</span><strong>${decision?.hasNextPick ? `${Math.round(decision.availability * 100)}%` : "Final"}</strong></div><div><span>MC lineup</span><strong>${mc ? `${mc.expectedWeekly.toFixed(1)}/wk` : "Pending"}</strong></div></div><div class="what-if-result"><strong>What-if:</strong> projected starting lineup moves from ${before.weekly.toFixed(1)} to ${after.weekly.toFixed(1)} PPR points/week; roster score changes ${after.score - before.score >= 0 ? "+" : ""}${(after.score - before.score).toFixed(1)}.</div></article>`;
  }).join("");
  elements.compareContent.innerHTML = `<div class="comparison-grid">${cards}</div>`;
  elements.compareDialog.showModal();
}

function recordRecommendationFeedback(sentiment, playerId) {
  state.feedback.push({ sentiment, playerId, pickIndex: state.picks.length, roster: draftedPlayersForTeam(state.settings.userSlot).map((player) => player.id), observedAt: new Date().toISOString(), settings: { teams: state.settings.teams, slot: state.settings.userSlot, preset: state.settings.preset } });
  saveState();
  showToast(sentiment === "agree" ? "Recommendation feedback saved" : "Preference noted for model review");
}

function draftReport() {
  const rosters = allRosters();
  const providerGrades = Object.fromEntries([...providerSummary.usableProviders, ...(providerSummary.usableProviders.length ? ["consensus"] : [])].map((provider) => [provider, providerRosterGrades(rosters, state.settings, provider)]));
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    scoring: "PPR",
    settings: state.settings,
    leagueImport: state.leagueImport,
    picks: state.picks,
    keepers: state.keepers,
    tradedPicks: state.tradedPicks,
    opponents: state.opponentBeliefs,
    teams: rosters.map((roster, team) => ({ team, grade: rosterGrade(roster), evaluation: evaluateRoster(roster, state.settings, rosters), players: roster.map((player) => ({ id: player.id, name: player.name, position: player.position, team: player.team, projection: player.projection })) })),
    providerEvidence: { generatedAt: providerSnapshot?.generatedAt || null, providers: providerSnapshot?.providers || {}, grades: providerGrades },
    learningProfile,
    feedback: state.feedback
  };
}

function currentDraftLogEntry(status = isComplete() ? "complete" : "in-progress") {
  const report = draftReport();
  const userTeam = report.teams.find((team) => team.team === state.settings.userSlot);
  return {
    id: state.draftId,
    startedAt: state.startedAt,
    completedAt: status === "complete" ? new Date().toISOString() : null,
    status,
    scoring: "PPR",
    settingsFingerprint: settingsFingerprint({ ...state.settings, gradeVersion: GRADE_MODEL_VERSION }),
    gradeModelVersion: GRADE_MODEL_VERSION,
    settings: { teams: state.settings.teams, rounds: state.settings.rounds, userSlot: state.settings.userSlot, draftFormat: state.settings.draftFormat, rosterSlots: state.settings.rosterSlots, tePremium: state.settings.tePremium },
    pickCount: state.picks.length + state.keepers.length,
    picks: state.picks.map((pick) => { const player = dataset.players.find((item) => item.id === pick.playerId); return { playerId: pick.playerId, team: pick.team, index: pick.index, price: pick.price || null, position: player?.position || null }; }),
    keepers: state.keepers,
    userScore: userTeam?.evaluation?.score ?? null,
    userGrade: userTeam?.grade ?? "—",
    teamResults: report.teams.map((team) => ({ team: team.team, grade: team.grade, score: team.evaluation.score, weekly: team.evaluation.weekly, expectedWins: team.evaluation.expectedWins })),
    providerGrades: report.providerEvidence.grades,
    learning: { completedDrafts: learningProfile.completedDrafts, providerInfluence: learningProfile.providerInfluence, regretEma: learningProfile.regretEma },
    feedbackCount: state.feedback.length
  };
}

async function logCurrentDraft(status) {
  if (!state.picks.length && !state.keepers.length) return null;
  if (status === "complete") {
    const learning = updateLearningFromDraft(learningProfile, { draftId: state.draftId, picks: state.picks, keepers: state.keepers, players: dataset.players, userSlot: state.settings.userSlot, teams: state.settings.teams, draftFormat: state.settings.draftFormat });
    if (learning.updated) {
      learningProfile = learning.profile;
      saveLearningProfile(learningProfile);
      recalculateModel();
      if (elements.leagueDialog.open) renderLeagueResults();
    }
  }
  const entry = await putDraftLog(currentDraftLogEntry(status));
  draftHistory = [entry, ...draftHistory.filter((item) => item.id !== entry.id)];
  return entry;
}

async function openDraftLog() {
  await logCurrentDraft(isComplete() ? "complete" : "in-progress");
  draftHistory = await getDraftLogs();
  const rows = draftHistory.map((entry) => { const providerGrade = entry.providerGrades?.consensus?.find((grade) => grade.team === entry.settings?.userSlot)?.grade; return `<tr><td>${new Date(entry.startedAt).toLocaleString()}</td><td>${escapeHtml(entry.status)}</td><td>${entry.settings?.teams || "—"} teams · ${escapeHtml(entry.settings?.draftFormat || "snake")}</td><td>${entry.pickCount}</td><td>${escapeHtml(entry.userGrade || "—")}${providerGrade ? ` / ${escapeHtml(providerGrade)}` : ""}</td></tr>`; }).join("");
  elements.compareContent.innerHTML = `<div class="comparison-card audit-log"><p class="eyebrow">Persistent browser ledger</p><h3>Draft log</h3><p>Every started room is retained on this device. Local and FantasyPros/SportsDataIO consensus grades remain separate and the learning profile records only bounded, dual-provider regret updates.</p><div class="table-wrap"><table><thead><tr><th>Started</th><th>Status</th><th>Format</th><th>Picks</th><th>Local / providers</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No drafts logged yet.</td></tr>"}</tbody></table></div><button class="button button-dark" type="button" data-export-ledger>Export complete log</button></div>`;
  elements.compareDialog.showModal();
}

async function exportDraftLedger() {
  const entries = await getDraftLogs();
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), drafts: entries }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `war-room-draft-ledger-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function exportDraftReport() {
  const blob = new Blob([JSON.stringify(draftReport(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `war-room-ppr-draft-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function copyShareLink() {
  const share = { settings: state.settings, keepers: state.keepers, tradedPicks: state.tradedPicks };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(share))));
  const url = new URL(location.href);
  url.searchParams.set("room", encoded);
  await navigator.clipboard.writeText(url.toString());
  showToast("Shareable room configuration copied");
}

function runDraftBacktest() {
  const report = backtestCompletedDraft({ players: dataset.players, picks: state.picks, rosters: allRosters(), settings: state.settings });
  const coverage = Math.round(report.outcomeCoverage * 100);
  elements.compareContent.innerHTML = `<div class="comparison-card"><p class="eyebrow">Historical evaluation</p><h3>${report.status === "exploratory" ? "Exploratory backtest" : "More outcomes needed"}</h3><div class="comparison-metrics"><div><span>Outcome coverage</span><strong>${coverage}%</strong></div><div><span>Recommendation regret</span><strong>${report.recommendationRegret?.toFixed(1) ?? "—"}</strong></div><div><span>Projection MAE</span><strong>${report.projectionCalibrationMae?.toFixed(1) ?? "—"}</strong></div><div><span>Legal lineups</span><strong>${Math.round(report.legalLineupRate * 100)}%</strong></div></div><p>${escapeHtml(report.limitation)}</p><div class="grade-explain">${report.segments.map((segment) => `<span>Slot ${segment.draftSlot}: ${segment.actualWeeklyPpr.toFixed(1)} actual PPR/wk · ${Math.round(segment.playoffProbability * 100)}% playoff · ${Math.round(segment.championshipProbability * 100)}% title</span>`).join("")}</div></div>`;
  elements.compareDialog.showModal();
}

elements.searchInput.addEventListener("input", () => { syncBoardUrl(); renderBoard(); });
elements.undoButton.addEventListener("click", undo);
elements.settingsButton.addEventListener("click", openSetup);
elements.simulateButton.addEventListener("click", runToUserPick);
elements.fullSimButton.addEventListener("click", simulateFullDraft);
elements.viewLeagueButton.addEventListener("click", openLeagueResults);
elements.closeLeagueButton.addEventListener("click", () => elements.leagueDialog.close());
elements.closeCompareButton.addEventListener("click", () => elements.compareDialog.close());
elements.compareButton.addEventListener("click", () => openComparison());
elements.importSleeperButton.addEventListener("click", importSleeperLeague);
elements.exportDraftButton.addEventListener("click", exportDraftReport);
elements.shareDraftButton.addEventListener("click", () => copyShareLink().catch(() => showToast("Copy failed; use the address bar link")));
elements.draftLogButton.addEventListener("click", () => void openDraftLog());
elements.runBacktestButton.addEventListener("click", runDraftBacktest);
elements.teamCount.addEventListener("change", () => populateSlots(Number(elements.userSlot.value)));
elements.newDraftButton.addEventListener("click", startNewDraft);
elements.projectionFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { await importProjections(file); }
  catch (error) { elements.importStatus.textContent = error.message; showToast("Projection import could not be matched"); }
  finally { event.target.value = ""; }
});
elements.clearModelButton.addEventListener("click", clearProjectionModel);

try {
  const response = await fetch("data/players.json");
  if (!response.ok) throw new Error(`Player data returned ${response.status}`);
  dataset = await response.json();
  dataset.players.forEach((player) => { player.baseProjection = player.projection; player.baseVbd = player.vbd; });
  try {
    const liveResponse = await fetch("data/live-player-context.json");
    if (liveResponse.ok) {
      liveContext = await liveResponse.json();
      applyLiveContext(liveContext);
    }
  } catch { /* The daily live snapshot is optional. */ }
  state.picks = state.picks.filter((pick) => dataset.players.some((player) => player.id === pick.playerId));
  const initialParams = new URL(location.href).searchParams;
  if (initialParams.get("room")) {
    try {
      const shared = JSON.parse(decodeURIComponent(escape(atob(initialParams.get("room")))));
      const settings = normalizeLeagueSettings({ ...state.settings, ...shared.settings });
      state = { ...state, settings, picks: [], cursor: 0, keepers: (shared.keepers || []).filter((keeper) => dataset.players.some((player) => player.id === keeper.playerId)), tradedPicks: shared.tradedPicks || {}, opponentBeliefs: createOpponentBeliefs(settings.teams, settings.userSlot), simulationSeed: Math.floor(Math.random() * 2 ** 31) };
    } catch { showToast("Shared room configuration was invalid"); }
  }
  activePosition = POSITIONS.includes((initialParams.get("pos") || "").toUpperCase()) ? initialParams.get("pos").toUpperCase() : "ALL";
  elements.searchInput.value = initialParams.get("q") || "";
  if (!state.model?.data) {
    try {
      const bundled = await fetch("data/ffanalytics-projections.csv");
      if (bundled.ok) state.model = modelFromProjectionText(await bundled.text(), "bundled ffanalytics-projections.csv");
    } catch { /* The generated consensus file is optional. */ }
  }
  try {
    const providerResponse = await fetch("data/provider-projections.json");
    if (providerResponse.ok) providerSnapshot = await providerResponse.json();
  } catch { /* Provider snapshots are optional until repository secrets are configured. */ }
  recalculateModel();
  saveState();
  draftHistory = await getDraftLogs();
  if (state.picks.length || state.keepers.length) await logCurrentDraft(isComplete() ? "complete" : "in-progress");
  renderAll();
} catch (error) {
  elements.playerRows.innerHTML = `<tr><td class="empty-row" colspan="7">Player data could not load. Run this app through the included local server.</td></tr>`;
  elements.methodology.textContent = error.message;
  console.error(error);
}
