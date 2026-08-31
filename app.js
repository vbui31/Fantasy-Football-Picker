import { enrichPlayerModel, nextPickIndexForTeam, scoreCandidate } from "./draft-model.js";
import { buildProjectionDataset, parseCsv } from "./ffanalytics-data.js";

const POSITIONS = ["ALL", "RB", "WR", "QB", "TE", "FLEX", "K", "DST"];
const STARTERS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DST"];
const OPPONENT_PROFILE = {
  source: "Fantasy Meltdown ADP room · 10 full mocks · 2026-08-30",
  targetRoster: { QB: 1.7, RB: 4.2, WR: 5.4, TE: 1.7, K: 1, DST: 1 },
  medianFirstRound: { QB: 7, TE: 7, K: 15, DST: 14 }
};
const STORAGE_KEY = "war-room-draft-v1";

const elements = Object.fromEntries([
  "playerRows", "poolCount", "searchInput", "positionFilters", "methodology", "clockTeam", "roundLabel",
  "pickLabel", "clockTrack", "recommendationCard", "alternatives", "confidence", "rosterTitle", "rosterGrade",
  "needsStrip", "rosterList", "historyList", "undoButton", "settingsButton", "simulateButton", "setupDialog",
  "setupForm", "teamCount", "userSlot", "roundCount", "autoOpponents", "newDraftButton", "toast", "saveState",
  "projectionFile", "importStatus", "clearModelButton", "modelState", "fullSimButton", "simulationPace",
  "viewLeagueButton", "leagueDialog", "closeLeagueButton", "leagueGrid", "leagueSummary"
].map((id) => [id, document.getElementById(id)]));

let dataset;
let activePosition = "ALL";
let toastTimer;
let simulationNonce = 0;
let isSimulating = false;
let state = loadState();

function defaultState() {
  return { version: 1, settings: { teams: 10, userSlot: 5, rounds: 15, autoOpponents: true, simulationPace: 220 }, picks: [], model: null };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.version === 1 && Array.isArray(saved.picks)) return { ...saved, settings: { ...defaultState().settings, ...saved.settings } };
  } catch { /* A fresh board is safer than a broken saved state. */ }
  return defaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  elements.saveState.innerHTML = "<i></i> Saved locally";
}

function teamName(index) { return index === state.settings.userSlot ? `Your team · ${index + 1}` : `Team ${index + 1}`; }

function pickContext(pickIndex = state.picks.length) {
  const { teams } = state.settings;
  const round = Math.floor(pickIndex / teams);
  const offset = pickIndex % teams;
  const team = round % 2 === 0 ? offset : teams - 1 - offset;
  return { round, offset, team, overall: pickIndex + 1 };
}

function isComplete() { return state.picks.length >= state.settings.teams * state.settings.rounds; }

function availablePlayers() {
  const drafted = new Set(state.picks.map((pick) => pick.playerId));
  return dataset.players.filter((player) => !drafted.has(player.id));
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
    player.modelSource = "registry";
  }

  if (state.model?.data) {
    for (const player of dataset.players) {
      const imported = state.model.data[player.id];
      if (!imported) continue;
      Object.assign(player, imported, { modelSource: "ffanalytics" });
    }
  }

  const replacement = enrichPlayerModel(dataset.players, state.settings);

  dataset.players.sort((a, b) => b.vbd - a.vbd || b.projection - a.projection || a.sourceRank - b.sourceRank);
  dataset.players.forEach((player, index) => { player.rank = index + 1; });
  const consensus = state.model?.source === "ffanalytics";
  elements.modelState.textContent = consensus ? `Consensus · ${state.model.matches} matched` : "Registry model";
  elements.modelState.classList.toggle("consensus", consensus);
  elements.importStatus.textContent = consensus
    ? `${state.model.matches} players matched from ${state.model.fileName}${state.model.scoringFormat ? ` · ${state.model.scoringFormat.toUpperCase()}` : ""}${state.model.generatedAt ? ` · generated ${new Intl.DateTimeFormat().format(new Date(state.model.generatedAt))}` : ""}. ${state.model.unmatched} rows were unmatched or unusable.`
    : "No consensus file loaded.";
  elements.clearModelButton.hidden = !consensus;
  elements.methodology.textContent = consensus
    ? `ffanalytics weighted consensus from ${state.model.fileName} supplies projections, ranges, expert ranks, ADP, auction values, and uncertainty. Dynamic replacement levels (${Object.entries(replacement).map(([position, rank]) => `${position}${rank}`).join(", ")}), probabilistic tiers, and next-turn availability are recalculated for this room.`
    : `${dataset.methodology} Dynamic replacement levels, probabilistic tiers, and next-turn availability are recalculated for this ${state.settings.teams}-team room.`;
}

function draftedPlayersForTeam(team) {
  const byId = new Map(dataset.players.map((player) => [player.id, player]));
  return state.picks.filter((pick) => pick.team === team).map((pick) => byId.get(pick.playerId)).filter(Boolean);
}

function countPositions(roster) {
  return roster.reduce((counts, player) => ({ ...counts, [player.position]: (counts[player.position] || 0) + 1 }), {});
}

function recommendations(team = pickContext().team) {
  const roster = draftedPlayersForTeam(team);
  const context = pickContext();
  const available = availablePlayers();
  const nextPickIndex = nextPickIndexForTeam(state.picks.length, team, state.settings.teams, state.settings.teams * state.settings.rounds);
  return available
    .map((player) => ({ player, ...scoreCandidate(player, { roster, round: context.round, currentPickIndex: state.picks.length, nextPickIndex, availablePlayers: available, profile: OPPONENT_PROFILE }) }))
    .sort((a, b) => b.score - a.score || b.player.vbd - a.player.vbd || a.player.rank - b.player.rank);
}

function slotRoster(players) {
  const slots = [...STARTERS, ...Array.from({ length: Math.max(0, state.settings.rounds - STARTERS.length) }, (_, index) => `BN${index + 1}`)];
  const assigned = slots.map((slot) => ({ slot, player: null }));
  for (const player of players) {
    let target = assigned.find((entry) => !entry.player && entry.slot === player.position);
    if (!target && ["RB", "WR", "TE"].includes(player.position)) target = assigned.find((entry) => !entry.player && entry.slot === "FLEX");
    if (!target) target = assigned.find((entry) => !entry.player && entry.slot.startsWith("BN"));
    if (target) target.player = player;
  }
  return assigned;
}

function rosterGrade(players) {
  if (!players.length) return "—";
  const scores = Array.from({ length: state.settings.teams }, (_, team) => rosterQuality(draftedPlayersForTeam(team)));
  const score = rosterQuality(players);
  const rank = [...scores].sort((a, b) => b - a).indexOf(score);
  const percentile = scores.length > 1 ? 1 - rank / (scores.length - 1) : .5;
  return percentile >= .9 ? "A" : percentile >= .72 ? "A−" : percentile >= .55 ? "B+" : percentile >= .38 ? "B" : percentile >= .2 ? "C+" : "C";
}

function rosterQuality(players) {
  if (!players.length) return -1000;
  const counts = countPositions(players);
  const coverage = [counts.QB, counts.RB >= 2, counts.WR >= 2, counts.TE, counts.K, counts.DST].filter(Boolean).length;
  const projection = players.reduce((sum, player) => sum + player.projection, 0);
  const value = players.reduce((sum, player) => sum + player.vbd, 0);
  return value + projection * .04 + coverage * 11;
}

function renderFilters() {
  elements.positionFilters.innerHTML = POSITIONS.map((position) => `<button class="filter-button ${position === activePosition ? "active" : ""}" type="button" data-position="${position}">${position}</button>`).join("");
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
  const nextPickIndex = nextPickIndexForTeam(state.picks.length, team, state.settings.teams, state.settings.teams * state.settings.rounds);
  const roster = draftedPlayersForTeam(team);
  const available = availablePlayers();
  elements.playerRows.innerHTML = players.slice(0, 50).map((player) => {
    const decision = scoreCandidate(player, { roster, round: context.round, currentPickIndex: state.picks.length, nextPickIndex, availablePlayers: available, profile: OPPONENT_PROFILE });
    const signal = player.injury || `T${player.tier} · ${decision.hasNextPick ? `${Math.round(decision.availability * 100)}% next` : "final turn"}`;
    const lowRisk = Number.isFinite(player.uncertainty) && player.uncertainty <= (player.uncertainty <= 1 ? .33 : 33);
    return `<tr>
      <td class="rank-cell">${player.rank}</td>
      <td class="player-name"><strong>${escapeHtml(player.name)}</strong><small>${player.team} · ${player.yearsExperience ?? "—"} yr exp</small></td>
      <td><span class="pos-badge pos-${player.position}">${player.position}</span></td>
      <td class="metric">${player.projection.toFixed(1)}</td>
      <td class="metric ${player.vbd > 0 ? "vbd-positive" : ""}">${player.vbd > 0 ? "+" : ""}${player.vbd.toFixed(1)}</td>
      <td class="signal ${player.injury ? "warn" : lowRisk ? "low-risk" : ""}">${escapeHtml(signal)}</td>
      <td><button class="draft-button" type="button" data-draft="${player.id}" ${isComplete() || isSimulating ? "disabled" : ""}>Draft</button></td>
    </tr>`;
  }).join("") || `<tr><td class="empty-row" colspan="7">No available players match this filter.</td></tr>`;
}

function renderClock() {
  if (isComplete()) {
    elements.clockTeam.textContent = "Draft complete";
    elements.roundLabel.textContent = `${state.settings.rounds} rounds`;
    elements.pickLabel.textContent = `${state.picks.length} picks made`;
    elements.clockTrack.innerHTML = "";
    elements.simulateButton.disabled = true;
    elements.fullSimButton.disabled = true;
    elements.fullSimButton.textContent = "Draft Complete";
    return;
  }
  const context = pickContext();
  elements.clockTeam.textContent = teamName(context.team);
  elements.roundLabel.textContent = `Round ${context.round + 1}`;
  elements.pickLabel.textContent = `Pick ${context.round + 1}.${String(context.offset + 1).padStart(2, "0")} · #${context.overall}`;
  elements.clockTrack.innerHTML = Array.from({ length: state.settings.teams }, (_, index) => `<span class="clock-dot ${index < context.offset ? "done" : index === context.offset ? "current" : ""}"></span>`).join("");
  elements.simulateButton.disabled = isSimulating || context.team === state.settings.userSlot;
  elements.simulateButton.textContent = context.team === state.settings.userSlot ? "Your Pick Is Ready" : "Run to My Pick";
  elements.fullSimButton.disabled = false;
  elements.fullSimButton.textContent = isSimulating ? "Pause Simulation" : "Simulate Full Draft";
}

function renderRecommendation() {
  if (isComplete()) {
    elements.recommendationCard.innerHTML = `<h2>Board Closed</h2><p class="rec-reason">The draft is complete. Compare every roster, grade the room, or start a new draft.</p><button class="button button-gold" type="button" data-open-results>View League Results</button>`;
    elements.alternatives.innerHTML = "";
    elements.confidence.textContent = "Final";
    return;
  }
  const context = pickContext();
  const picks = recommendations(context.team);
  const bestPick = picks[0];
  const best = bestPick?.player;
  if (!best) return;
  const gap = picks[0].score - (picks[1]?.score ?? picks[0].score);
  elements.confidence.textContent = gap > 15 ? "Strong edge" : gap > 6 ? "Clear lean" : "Close call";
  const consensusMeta = best.modelSource === "ffanalytics" ? `${best.projectionMethod?.toUpperCase() || "FFA"} CONSENSUS${best.consensusTier ? ` · SOURCE TIER ${best.consensusTier}` : ""}` : best.depthOrder === 1 ? "PROJECTED STARTER" : "ACTIVE ROSTER";
  const factorRows = bestPick.factors.slice(0, 4).map((factor) => `<li><span>${escapeHtml(factor.label)}</span><strong class="${factor.impact >= 0 ? "positive" : "negative"}">${factor.impact >= 0 ? "+" : ""}${factor.impact.toFixed(1)}</strong><small>${escapeHtml(factor.detail)}</small></li>`).join("");
  elements.recommendationCard.innerHTML = `
    <div class="rec-topline"><span class="pos-badge pos-${best.position}">${best.position}</span><span class="rec-rank">BOARD #${best.rank}</span></div>
    <h2 id="recommendationTitle">${escapeHtml(best.name)}</h2>
    <div class="rec-meta">${best.team} · ${consensusMeta}</div>
    <p class="rec-reason">Best combined value, roster fit, tier urgency, and likelihood of disappearing before your next turn.</p>
    <div class="rec-metrics"><div><span>Est. points</span><strong>${best.projection.toFixed(1)}</strong></div><div><span>Dynamic VBD</span><strong>${best.vbd > 0 ? "+" : ""}${best.vbd.toFixed(1)}</strong></div><div><span>Tier confidence</span><strong>T${best.tier} · ${Math.round(best.tierProbability * 100)}%</strong></div><div><span>Chance at next pick</span><strong>${bestPick.hasNextPick ? `${Math.round(bestPick.availability * 100)}%` : "No next turn"}</strong></div></div>
    <div class="factor-heading">Why the model likes this pick</div><ul class="factor-list">${factorRows}</ul>
    <button class="button button-gold" type="button" data-draft="${best.id}">Draft ${escapeHtml(best.lastName || best.name)}</button>`;
  elements.alternatives.innerHTML = picks.slice(1, 4).map(({ player }, index) => `<div class="alternative"><em>0${index + 2}</em><strong>${escapeHtml(player.name)}</strong><span class="pos-badge pos-${player.position}">${player.position}</span></div>`).join("");
}

function renderRoster() {
  const team = state.settings.userSlot;
  const players = draftedPlayersForTeam(team);
  const counts = countPositions(players);
  elements.rosterTitle.textContent = `Team ${team + 1} roster`;
  elements.rosterGrade.textContent = rosterGrade(players);
  const needs = [{ p: "QB", n: 1 }, { p: "RB", n: 2 }, { p: "WR", n: 2 }, { p: "TE", n: 1 }, { p: "FLEX", n: 2 }, { p: "K", n: 1 }, { p: "DST", n: 1 }];
  const skillExtra = Math.max(0, (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0) - 5);
  elements.needsStrip.innerHTML = needs.map(({ p, n }) => {
    const filled = p === "FLEX" ? Math.min(n, skillExtra) : Math.min(n, counts[p] || 0);
    return `<span class="need-chip ${filled >= n ? "filled" : "open"}">${p} ${filled}/${n}</span>`;
  }).join("");
  elements.rosterList.innerHTML = slotRoster(players).map(({ slot, player }) => `<div class="roster-row"><span class="slot">${slot}</span>${player ? `<strong>${escapeHtml(player.name)}</strong><small>${player.team} · ${player.position}</small>` : `<span class="empty">Open slot</span><small>—</small>`}</div>`).join("");
}

function renderHistory() {
  const byId = new Map(dataset.players.map((player) => [player.id, player]));
  const recent = state.picks.slice(-8).reverse();
  elements.historyList.innerHTML = recent.map((pick) => {
    const player = byId.get(pick.playerId);
    return `<div class="history-row"><span>#${pick.index + 1}</span><strong>${escapeHtml(player?.name || "Unknown player")}</strong><small>${teamName(pick.team)}</small></div>`;
  }).join("") || `<div class="history-empty">No picks yet. The board is yours.</div>`;
  elements.undoButton.disabled = !state.picks.length || isSimulating;
}

function renderLeagueResults() {
  const teamRows = Array.from({ length: state.settings.teams }, (_, team) => {
    const players = draftedPlayersForTeam(team);
    return { team, players, score: rosterQuality(players), grade: rosterGrade(players) };
  }).sort((a, b) => b.score - a.score);
  const leader = teamRows[0];
  elements.leagueSummary.textContent = state.picks.length
    ? `${state.picks.length} of ${state.settings.teams * state.settings.rounds} picks complete. ${teamName(leader.team)} currently leads the room.`
    : "Team grades update after every pick and compare value, projected output, and roster coverage.";
  elements.leagueGrid.innerHTML = teamRows.map(({ team, players, grade }, index) => {
    const counts = countPositions(players);
    const projection = players.reduce((sum, player) => sum + player.projection, 0);
    return `<article class="team-card ${team === state.settings.userSlot ? "is-user" : ""}">
      <header><div><span>${index === 0 && players.length ? "ROOM LEADER" : `DRAFT SLOT ${team + 1}`}</span><h3>${escapeHtml(teamName(team))}</h3></div><strong>${grade}</strong></header>
      <div class="team-card-stats"><span>${players.length} picks</span><span>${projection.toLocaleString(undefined, { maximumFractionDigits: 1 })} pts</span><span>QB ${counts.QB || 0} · RB ${counts.RB || 0} · WR ${counts.WR || 0} · TE ${counts.TE || 0}</span></div>
      <ol>${players.map((player) => `<li><span class="pos-badge pos-${player.position}">${player.position}</span><strong>${escapeHtml(player.name)}</strong><small>${player.team}</small></li>`).join("") || "<li class=\"team-empty\">No picks yet.</li>"}</ol>
    </article>`;
  }).join("");
}

function renderAll() {
  renderFilters();
  renderClock();
  renderBoard();
  renderRecommendation();
  renderRoster();
  renderHistory();
  if (elements.leagueDialog.open) renderLeagueResults();
}

function draftPlayer(playerId, isAuto = false) {
  if (isComplete() || state.picks.some((pick) => pick.playerId === playerId)) return;
  const context = pickContext();
  state.picks.push({ playerId, team: context.team, index: state.picks.length });
  saveState();
  renderAll();
  if (!isAuto) {
    const player = dataset.players.find((candidate) => candidate.id === playerId);
    showToast(`${player.name} drafted by ${teamName(context.team)}`);
    if (state.settings.autoOpponents && !isComplete()) setTimeout(runToUserPick, 180);
  }
}

function autoPick() {
  const context = pickContext();
  const choices = recommendations(context.team).slice(0, 7);
  if (!choices.length) return;
  const seed = (state.picks.length * 17 + context.team * 11) % choices.length;
  draftPlayer(choices[seed].player.id, true);
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
  saveState();
  renderAll();
  showToast("Last selection undone");
}

function populateSlots(selected = state.settings.userSlot) {
  const teams = Number(elements.teamCount.value || state.settings.teams);
  elements.userSlot.innerHTML = Array.from({ length: teams }, (_, index) => `<option value="${index}" ${index === Math.min(selected, teams - 1) ? "selected" : ""}>Pick ${index + 1}</option>`).join("");
}

function openSetup() {
  simulationNonce++;
  isSimulating = false;
  elements.teamCount.value = state.settings.teams;
  elements.roundCount.value = state.settings.rounds;
  elements.autoOpponents.checked = state.settings.autoOpponents;
  elements.simulationPace.value = String(state.settings.simulationPace);
  populateSlots();
  recalculateModel();
  elements.setupDialog.showModal();
}

function startNewDraft(event) {
  event.preventDefault();
  simulationNonce++;
  isSimulating = false;
  state = {
    version: 1,
    settings: {
      teams: Number(elements.teamCount.value),
      userSlot: Number(elements.userSlot.value),
      rounds: Number(elements.roundCount.value),
      autoOpponents: elements.autoOpponents.checked,
      simulationPace: Number(elements.simulationPace.value)
    },
    picks: [],
    model: state.model
  };
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
  if (event.target.closest("[data-open-results]")) openLeagueResults();
});
function syncBoardUrl() {
  const url = new URL(location.href);
  if (activePosition === "ALL") url.searchParams.delete("pos"); else url.searchParams.set("pos", activePosition);
  const query = elements.searchInput.value.trim();
  if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}
function openLeagueResults() { renderLeagueResults(); elements.leagueDialog.showModal(); }

elements.searchInput.addEventListener("input", () => { syncBoardUrl(); renderBoard(); });
elements.undoButton.addEventListener("click", undo);
elements.settingsButton.addEventListener("click", openSetup);
elements.simulateButton.addEventListener("click", runToUserPick);
elements.fullSimButton.addEventListener("click", simulateFullDraft);
elements.viewLeagueButton.addEventListener("click", openLeagueResults);
elements.closeLeagueButton.addEventListener("click", () => elements.leagueDialog.close());
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
  state.picks = state.picks.filter((pick) => dataset.players.some((player) => player.id === pick.playerId));
  const initialParams = new URL(location.href).searchParams;
  activePosition = POSITIONS.includes((initialParams.get("pos") || "").toUpperCase()) ? initialParams.get("pos").toUpperCase() : "ALL";
  elements.searchInput.value = initialParams.get("q") || "";
  if (!state.model?.data) {
    try {
      const bundled = await fetch("data/ffanalytics-projections.csv");
      if (bundled.ok) state.model = modelFromProjectionText(await bundled.text(), "bundled ffanalytics-projections.csv");
    } catch { /* The generated consensus file is optional. */ }
  }
  recalculateModel();
  saveState();
  renderAll();
} catch (error) {
  elements.playerRows.innerHTML = `<tr><td class="empty-row" colspan="7">Player data could not load. Run this app through the included local server.</td></tr>`;
  elements.methodology.textContent = error.message;
  console.error(error);
}
