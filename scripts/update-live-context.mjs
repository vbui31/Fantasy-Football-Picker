import { readFile, writeFile } from "node:fs/promises";
import { parseCsv } from "../ffanalytics-data.js";

const root = new URL("../", import.meta.url);
const outputUrl = new URL("data/live-player-context.json", root);
const registry = JSON.parse(await readFile(new URL("data/players.json", root), "utf8"));
const force = process.argv.includes("--force");

try {
  const existing = JSON.parse(await readFile(outputUrl, "utf8"));
  const ageHours = (Date.now() - Date.parse(existing.generatedAt)) / 3_600_000;
  if (!force && Number.isFinite(ageHours) && ageHours < 20) {
    console.log("Live context is " + ageHours.toFixed(1) + "h old; Sleeper's once-daily player-map limit is respected.");
    process.exit(0);
  }
} catch {}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Fantasy-Football-Picker/1.1 (github.com/vbui31/Fantasy-Football-Picker)" } });
  if (!response.ok) throw new Error(url + " returned " + response.status);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Fantasy-Football-Picker/1.1 (github.com/vbui31/Fantasy-Football-Picker)" } });
  if (!response.ok) throw new Error(url + " returned " + response.status);
  return response.text();
}

async function maybeText(url) {
  try { return await fetchText(url); } catch { return null; }
}

const sleeperBase = "https://api.sleeper.app/v1";
const sleeperPositions = ["QB", "RB", "WR", "TE", "K", "DEF"];
const scheduleUrl = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
const [state, sleeperPositionMaps, trendingAdds, trendingDrops, scheduleText] = await Promise.all([
  fetchJson(sleeperBase + "/state/nfl"),
  Promise.all(sleeperPositions.map((position) => fetchJson(sleeperBase + "/players/nfl?position=" + position + "&active=true"))),
  fetchJson(sleeperBase + "/players/nfl/trending/add?lookback_hours=24&limit=200"),
  fetchJson(sleeperBase + "/players/nfl/trending/drop?lookback_hours=24&limit=200"),
  fetchText(scheduleUrl)
]);

const sleeperPlayers = Object.assign({}, ...sleeperPositionMaps);
const positionRecords = Object.fromEntries(sleeperPositions.map((position, index) => [position, Object.keys(sleeperPositionMaps[index]).length]));
const currentSeason = Number(state.season);
const statsSeason = Number(state.previous_season || currentSeason - 1);
const [priorStatsText, currentStatsText] = await Promise.all([
  maybeText("https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_" + statsSeason + ".csv"),
  maybeText("https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_" + currentSeason + ".csv")
]);
const priorStatsRows = priorStatsText ? parseCsv(priorStatsText) : [];
const currentStatsRows = currentStatsText ? parseCsv(currentStatsText) : [];
const scheduleRows = parseCsv(scheduleText).filter((row) => Number(row.season) === currentSeason && (row.game_type || row.season_type || "REG") === "REG");
const currentWeek = Number(state.week || 1);

const number = (value) => value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const sum = (row, fields) => fields.reduce((total, field) => total + (number(row?.[field]) || 0), 0);
const safeRate = (a, b) => b ? a / b : null;

const scheduledWeeksByTeam = new Map();
const teams = {};
const ensureTeam = (team) => {
  if (!team) return null;
  if (!teams[team]) teams[team] = {
    offense: { games: 0, points: 0, pointsPerGame: null, passRate: null, offensiveTouchdownsPerGame: null },
    defense: { games: 0, pointsAllowed: 0, pointsAllowedPerGame: null, fantasyAllowedIndex: {} },
    remainingSchedule: []
  };
  return teams[team];
};

for (const game of scheduleRows) {
  const home = game.home_team;
  const away = game.away_team;
  for (const team of [home, away].filter(Boolean)) {
    if (!scheduledWeeksByTeam.has(team)) scheduledWeeksByTeam.set(team, new Set());
    scheduledWeeksByTeam.get(team).add(Number(game.week));
    ensureTeam(team);
  }
  const week = Number(game.week);
  if (Number.isFinite(week) && week >= currentWeek) {
    if (home && away) {
      teams[home].remainingSchedule.push({ week, opponent: away, home: true });
      teams[away].remainingSchedule.push({ week, opponent: home, home: false });
    }
  }
  const homeScore = number(game.home_score);
  const awayScore = number(game.away_score);
  if (home && away && homeScore !== null && awayScore !== null && week < currentWeek) {
    teams[home].offense.games++;
    teams[home].offense.points += homeScore;
    teams[home].defense.games++;
    teams[home].defense.pointsAllowed += awayScore;
    teams[away].offense.games++;
    teams[away].offense.points += awayScore;
    teams[away].defense.games++;
    teams[away].defense.pointsAllowed += homeScore;
  }
}

const byeWeeks = Object.fromEntries([...scheduledWeeksByTeam].map(([team, weeks]) => [team, Array.from({ length: 18 }, (_, index) => index + 1).find((week) => !weeks.has(week)) || null]));

for (const [team, record] of Object.entries(teams)) {
  record.remainingSchedule.sort((a, b) => a.week - b.week);
  record.offense.pointsPerGame = record.offense.games ? Number((record.offense.points / record.offense.games).toFixed(2)) : null;
  record.defense.pointsAllowedPerGame = record.defense.games ? Number((record.defense.pointsAllowed / record.defense.games).toFixed(2)) : null;
}

function statId(row) { return String(row.player_id || row.gsis_id || "").trim(); }
const priorStatsByGsis = new Map(priorStatsRows.map((row) => [statId(row), row]).filter(([id]) => id));
const currentStatsByGsis = new Map(currentStatsRows.map((row) => [statId(row), row]).filter(([id]) => id));

const teamUsage = {};
for (const row of currentStatsRows) {
  const team = row.recent_team || row.team;
  if (!team) continue;
  if (!teamUsage[team]) teamUsage[team] = { attempts: 0, carries: 0, passingTds: 0, rushingTds: 0, receivingTds: 0, games: 0 };
  teamUsage[team].attempts += number(row.attempts) || number(row.passing_attempts) || 0;
  teamUsage[team].carries += number(row.carries) || 0;
  teamUsage[team].passingTds += number(row.passing_tds) || 0;
  teamUsage[team].rushingTds += number(row.rushing_tds) || 0;
  teamUsage[team].receivingTds += number(row.receiving_tds) || 0;
  teamUsage[team].games = Math.max(teamUsage[team].games, number(row.games) || 0);
}
for (const [team, usage] of Object.entries(teamUsage)) {
  ensureTeam(team);
  const plays = usage.attempts + usage.carries;
  teams[team].offense.passRate = plays ? Number((usage.attempts / plays).toFixed(4)) : null;
  const games = teams[team].offense.games || usage.games || Math.max(1, currentWeek - 1);
  const touchdowns = Math.max(usage.passingTds, usage.receivingTds) + usage.rushingTds;
  teams[team].offense.offensiveTouchdownsPerGame = games ? Number((touchdowns / games).toFixed(2)) : null;
}

const addsById = new Map(trendingAdds.map((entry) => [String(entry.player_id), Number(entry.count) || 0]));
const dropsById = new Map(trendingDrops.map((entry) => [String(entry.player_id), Number(entry.count) || 0]));

function playerStats(row, season) {
  if (!row) return null;
  const games = number(row.games) || 0;
  const fantasy = number(row.fantasy_points_ppr);
  return {
    season,
    games,
    fantasyPointsPpr: fantasy,
    pointsPerGame: fantasy !== null && games ? Number((fantasy / games).toFixed(2)) : null,
    targetShare: number(row.target_share),
    wopr: number(row.wopr),
    carries: number(row.carries),
    targets: number(row.targets),
    receptions: number(row.receptions),
    rushingYards: number(row.rushing_yards),
    receivingYards: number(row.receiving_yards),
    passingYards: number(row.passing_yards),
    passAttempts: number(row.attempts) ?? number(row.passing_attempts),
    totalTouchdowns: sum(row, ["passing_tds", "rushing_tds", "receiving_tds", "special_teams_tds"])
  };
}

const players = {};
let sleeperMatched = 0;
let priorStatsMatched = 0;
let currentStatsMatched = 0;
let withAvailability = 0;
let withNewsTimestamp = 0;

for (const registryPlayer of registry.players) {
  const live = sleeperPlayers[registryPlayer.id];
  if (!live) continue;
  sleeperMatched++;
  const gsisId = String(live.gsis_id || "").trim() || null;
  const priorStats = gsisId ? priorStatsByGsis.get(gsisId) : null;
  const currentStats = gsisId ? currentStatsByGsis.get(gsisId) : null;
  if (priorStats) priorStatsMatched++;
  if (currentStats) currentStatsMatched++;
  if (live.injury_status || live.practice_participation || live.status) withAvailability++;
  if (number(live.news_updated)) withNewsTimestamp++;
  players[registryPlayer.id] = {
    team: live.team || null,
    position: live.position || registryPlayer.position,
    status: live.status || null,
    injuryStatus: live.injury_status || null,
    injuryBodyPart: live.injury_body_part || null,
    injuryStartDate: live.injury_start_date || null,
    practiceParticipation: live.practice_participation || null,
    practiceDescription: live.practice_description || null,
    depthChartOrder: number(live.depth_chart_order),
    depthChartPosition: live.depth_chart_position || null,
    byeWeek: byeWeeks[live.team] || null,
    newsUpdated: number(live.news_updated),
    gsisId,
    trendingAdds: addsById.get(registryPlayer.id) || 0,
    trendingDrops: dropsById.get(registryPlayer.id) || 0,
    currentSeason: playerStats(currentStats, currentSeason),
    lastSeason: playerStats(priorStats, statsSeason)
  };
}

const registryPlayers = registry.players.length;
const context = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  season: { season: currentSeason, week: currentWeek, seasonType: state.season_type || null, statsSeason },
  sources: [
    { name: "Sleeper NFL API", url: "https://docs.sleeper.com/#players", kind: "daily active player metadata, injuries, depth chart and 24-hour add/drop trends", cadence: "daily" },
    { name: "nflverse player stats", url: "https://github.com/nflverse/nflverse-data/releases/tag/stats_player", kind: "current and prior regular-season player production", cadence: "release-driven" },
    { name: "nflverse schedules", url: scheduleUrl, kind: "current schedule, scored games, remaining opponents and bye weeks", cadence: "release-driven" }
  ],
  quality: {
    registryPlayers,
    sleeperMatched,
    sleeperCoverage: Number((sleeperMatched / registryPlayers).toFixed(4)),
    currentStatsMatched,
    currentStatsCoverage: Number((currentStatsMatched / registryPlayers).toFixed(4)),
    priorStatsMatched,
    priorStatsCoverage: Number((priorStatsMatched / registryPlayers).toFixed(4)),
    withAvailability,
    withNewsTimestamp,
    byeWeekTeams: Object.keys(byeWeeks).length,
    scheduleTeams: Object.keys(teams).length,
    positionRecords,
    status: sleeperMatched / registryPlayers >= .8 ? "usable" : "degraded",
    limitations: [
      "Sleeper requests that player maps be fetched no more than once per day; this script caches for 20 hours.",
      "Coverage-shell rates are intentionally not inferred from box scores. The trade engine only uses coverage data when an explicit coverageProfile is supplied.",
      "Current-season nflverse rows may lag the most recent game until the upstream release refreshes.",
      "Rookies and players without a GSIS identifier can have incomplete historical statistics."
    ]
  },
  teams,
  players
};

if (context.quality.status !== "usable") throw new Error("Sleeper coverage " + context.quality.sleeperCoverage + " is below the 80% quality gate.");
await writeFile(outputUrl, JSON.stringify(context) + "\n", "utf8");
console.log("Live context written: " + sleeperMatched + "/" + registryPlayers + " Sleeper matches, " + currentStatsMatched + " current-season stat matches, " + Object.keys(teams).length + " schedule teams.");
