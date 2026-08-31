import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizedName } from "../ffanalytics-data.js";
import { normalizeFantasyProsProjection, normalizeSportsDataProjection, providerName, providerPosition, providerTeam } from "../provider-normalization.js";

const season = Number(process.env.NFL_SEASON || new Date().getUTCFullYear());
const outputPath = path.resolve(process.argv[2] || "data/provider-projections.json");
const playerPool = JSON.parse(await readFile(path.resolve("data/players.json"), "utf8"));
const fantasyProsKey = process.env.FANTASYPROS_API_KEY || "";
const sportsDataKey = process.env.SPORTSDATAIO_API_KEY || "";

const targetByKey = new Map();
const targetsByName = new Map();
for (const player of playerPool.players) {
  const name = normalizedName(player.name);
  targetByKey.set(`${name}|${player.position}`, player);
  if (!targetsByName.has(name)) targetsByName.set(name, []);
  targetsByName.get(name).push(player);
}

function targetFor(record) {
  const position = providerPosition(record);
  const team = providerTeam(record);
  if (position === "DST" && team) return playerPool.players.find((player) => player.position === "DST" && player.team === team) || null;
  const name = normalizedName(providerName(record));
  const exact = targetByKey.get(`${name}|${position}`);
  if (exact) return exact;
  const candidates = targetsByName.get(name) || [];
  return candidates.find((player) => !position || player.position === position) || candidates.find((player) => !team || player.team === team) || null;
}

async function requestJson(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fantasyProsRecords() {
  if (!fantasyProsKey) return { status: "not-configured", records: [] };
  const url = `https://api.fantasypros.com/public/v2/json/nfl/${season}/projections?positions=QB:RB:WR:TE:K:DST&week=0&scoring=PPR`;
  const payload = await requestJson(url, { "x-api-key": fantasyProsKey, Accept: "application/json" });
  return { status: "usable", records: Array.isArray(payload.players) ? payload.players : [] };
}

async function sportsDataRecords() {
  if (!sportsDataKey) return { status: "not-configured", records: [] };
  const headers = { "Ocp-Apim-Subscription-Key": sportsDataKey, Accept: "application/json" };
  const base = "https://api.sportsdata.io/v3/nfl/projections/json";
  const [players, defenses] = await Promise.all([
    requestJson(`${base}/PlayerSeasonProjectionStats/${season}REG`, headers),
    requestJson(`${base}/FantasyDefenseProjectionsBySeason/${season}REG`, headers).catch(() => [])
  ]);
  return { status: "usable", records: [...(Array.isArray(players) ? players : []), ...(Array.isArray(defenses) ? defenses.map((record) => ({ ...record, Position: "DST", Name: `${record.Team} Defense` })) : [])] };
}

function normalizedProviderRecord(provider, record) {
  return provider === "fantasypros" ? normalizeFantasyProsProjection(record) : normalizeSportsDataProjection(record);
}

const results = {};
for (const [provider, loader] of [["fantasypros", fantasyProsRecords], ["sportsdataio", sportsDataRecords]]) {
  try { results[provider] = await loader(); }
  catch (error) { results[provider] = { status: "error", error: error.message, records: [] }; }
}

const players = {};
const providerSummary = {};
for (const [provider, result] of Object.entries(results)) {
  let matches = 0;
  for (const record of result.records) {
    const target = targetFor(record);
    const normalized = normalizedProviderRecord(provider, record);
    if (!target || !Number.isFinite(normalized.projection)) continue;
    players[target.id] ||= {};
    players[target.id][provider] = normalized;
    matches++;
  }
  const status = result.status === "usable" && matches < 50 ? "insufficient-coverage" : result.status;
  providerSummary[provider] = { status, records: result.records.length, matches, ...(result.error ? { error: result.error } : {}) };
}

if (!Object.values(providerSummary).some((provider) => provider.matches > 0)) {
  console.log(`Provider refresh skipped: FantasyPros=${providerSummary.fantasypros.status}, SportsDataIO=${providerSummary.sportsdataio.status}.`);
  process.exit(0);
}

const output = { schemaVersion: 1, generatedAt: new Date().toISOString(), season, providers: providerSummary, players };
await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(`Provider projections: FantasyPros ${providerSummary.fantasypros.matches}/${providerSummary.fantasypros.records}; SportsDataIO ${providerSummary.sportsdataio.matches}/${providerSummary.sportsdataio.records}.`);
