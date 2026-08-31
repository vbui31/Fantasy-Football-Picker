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
    console.log(`Live context is ${ageHours.toFixed(1)}h old; Sleeper's once-daily player-map limit is respected.`);
    process.exit(0);
  }
} catch { /* First refresh has no cache. */ }

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Fantasy-Football-Picker/1.0 (github.com/vbui31/Fantasy-Football-Picker)" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Fantasy-Football-Picker/1.0 (github.com/vbui31/Fantasy-Football-Picker)" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

const sleeperBase = "https://api.sleeper.app/v1";
const [state, sleeperPlayers, trendingAdds, trendingDrops] = await Promise.all([
  fetchJson(`${sleeperBase}/state/nfl`),
  fetchJson(`${sleeperBase}/players/nfl?active=true`),
  fetchJson(`${sleeperBase}/players/nfl/trending/add?lookback_hours=24&limit=200`),
  fetchJson(`${sleeperBase}/players/nfl/trending/drop?lookback_hours=24&limit=200`)
]);

const statsSeason = Number(state.previous_season || Number(state.season) - 1);
const statsUrl = `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_${statsSeason}.csv`;
const statsRows = parseCsv(await fetchText(statsUrl));
const statsByGsis = new Map(statsRows.map((row) => [String(row.player_id || "").trim(), row]).filter(([id]) => id));
const addsById = new Map(trendingAdds.map((entry) => [String(entry.player_id), Number(entry.count) || 0]));
const dropsById = new Map(trendingDrops.map((entry) => [String(entry.player_id), Number(entry.count) || 0]));

const number = (value) => value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const sum = (row, fields) => fields.reduce((total, field) => total + (number(row?.[field]) || 0), 0);
const players = {};
let sleeperMatched = 0;
let statsMatched = 0;
let withAvailability = 0;
let withNewsTimestamp = 0;

for (const registryPlayer of registry.players) {
  const live = sleeperPlayers[registryPlayer.id];
  if (!live) continue;
  sleeperMatched++;
  const gsisId = String(live.gsis_id || "").trim() || null;
  const stats = gsisId ? statsByGsis.get(gsisId) : null;
  if (stats) statsMatched++;
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
    newsUpdated: number(live.news_updated),
    gsisId,
    trendingAdds: addsById.get(registryPlayer.id) || 0,
    trendingDrops: dropsById.get(registryPlayer.id) || 0,
    lastSeason: stats ? {
      season: statsSeason,
      games: number(stats.games),
      fantasyPointsPpr: number(stats.fantasy_points_ppr),
      pointsPerGame: number(stats.fantasy_points_ppr) !== null && number(stats.games) ? Number((number(stats.fantasy_points_ppr) / number(stats.games)).toFixed(2)) : null,
      targetShare: number(stats.target_share),
      wopr: number(stats.wopr),
      carries: number(stats.carries),
      targets: number(stats.targets),
      receptions: number(stats.receptions),
      rushingYards: number(stats.rushing_yards),
      receivingYards: number(stats.receiving_yards),
      totalTouchdowns: sum(stats, ["passing_tds", "rushing_tds", "receiving_tds", "special_teams_tds"])
    } : null
  };
}

const registryPlayers = registry.players.length;
const context = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  season: { season: number(state.season), week: number(state.week), seasonType: state.season_type || null, statsSeason },
  sources: [
    { name: "Sleeper NFL API", url: "https://docs.sleeper.com/", kind: "daily player metadata and 24-hour add/drop trends", cadence: "daily" },
    { name: "nflverse player stats", url: "https://github.com/nflverse/nflverse-data/releases/tag/stats_player", kind: "prior completed regular-season statistics", cadence: "release-driven" }
  ],
  quality: {
    registryPlayers,
    sleeperMatched,
    sleeperCoverage: Number((sleeperMatched / registryPlayers).toFixed(4)),
    statsMatched,
    statsCoverage: Number((statsMatched / registryPlayers).toFixed(4)),
    withAvailability,
    withNewsTimestamp,
    status: sleeperMatched / registryPlayers >= .8 ? "usable" : "degraded",
    limitations: [
      "Sleeper requests that the full NFL player map be fetched no more than once per day; this script caches for 20 hours.",
      "newsUpdated is a metadata timestamp, not licensed headline text or sentiment.",
      "nflverse statistics are historical context and are not a real-time scoring feed.",
      "Rookies and players without a GSIS identifier will not have prior-season statistics."
    ]
  },
  players
};

if (context.quality.status !== "usable") throw new Error(`Sleeper coverage ${context.quality.sleeperCoverage} is below the 80% quality gate.`);
await writeFile(outputUrl, `${JSON.stringify(context)}\n`, "utf8");
console.log(`Live context written: ${sleeperMatched}/${registryPlayers} Sleeper matches, ${statsMatched} historical-stat matches.`);
