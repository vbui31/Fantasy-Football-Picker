import fs from "node:fs";
import path from "node:path";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/build-player-pool.mjs <player-registry.json>");
  process.exit(1);
}

const target = path.resolve("data/players.json");
const registry = JSON.parse(fs.readFileSync(source, "utf8"));
const supported = new Set(["QB", "RB", "WR", "TE", "K"]);

const formulas = {
  QB: { ceiling: 360, slope: 1.8, floor: 180, replacement: 250 },
  RB: { ceiling: 300, slope: 1.5, floor: 80, replacement: 135 },
  WR: { ceiling: 290, slope: 1.35, floor: 75, replacement: 135 },
  TE: { ceiling: 230, slope: 1, floor: 55, replacement: 120 },
  K: { ceiling: 155, slope: 0.25, floor: 80, replacement: 125 }
};

function fantasyPosition(player) {
  return player.fantasy_positions?.find((position) => supported.has(position));
}

function estimate(player, position) {
  const model = formulas[position];
  const rank = Number.isFinite(player.search_rank) && player.search_rank < 9999999
    ? player.search_rank
    : 650 + (player.depth_chart_order || 5) * 35;
  const starterLift = player.depth_chart_order === 1 ? 8 : player.depth_chart_order === 2 ? 2 : 0;
  const projection = Math.max(model.floor, model.ceiling - rank * model.slope + starterLift);
  return {
    sourceRank: rank,
    projection: Math.round(projection * 10) / 10,
    vbd: Math.round((projection - model.replacement) * 10) / 10
  };
}

const players = Object.values(registry)
  .filter((player) => player.active && player.team && player.status === "Active")
  .map((player) => ({ player, position: fantasyPosition(player) }))
  .filter(({ position }) => position)
  .map(({ player, position }) => {
    const estimateValues = estimate(player, position);
    return {
      id: String(player.player_id),
      name: player.full_name,
      firstName: player.first_name,
      lastName: player.last_name,
      team: player.team,
      position,
      projection: estimateValues.projection,
      vbd: estimateValues.vbd,
      sourceRank: estimateValues.sourceRank,
      depthOrder: player.depth_chart_order || null,
      depthPosition: player.depth_chart_position || null,
      injury: player.injury_status || null,
      yearsExperience: player.years_exp ?? null,
      age: player.age ?? null,
      college: player.college || null,
      espnId: player.espn_id || null
    };
  });

const teams = [...new Set(players.map((player) => player.team))].sort();
for (const team of teams) {
  players.push({
    id: `DST-${team}`,
    name: `${team} Defense`,
    firstName: team,
    lastName: "Defense",
    team,
    position: "DST",
    projection: 112,
    vbd: 12,
    sourceRank: 700,
    depthOrder: 1,
    depthPosition: "DST",
    injury: null,
    yearsExperience: null,
    age: null,
    college: null,
    espnId: null
  });
}

const positionOrder = { RB: 0, WR: 1, QB: 2, TE: 3, DST: 4, K: 5 };
players.sort((a, b) => b.vbd - a.vbd || a.sourceRank - b.sourceRank || positionOrder[a.position] - positionOrder[b.position]);
players.forEach((player, index) => { player.rank = index + 1; });

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "Estimated projections derived from registry search rank, depth-chart order, and position-specific replacement baselines. They are decision aids, not statistical forecasts.",
  sourceRecords: Object.keys(registry).length,
  players
}));

console.log(`Wrote ${players.length} draftable entries to ${target}`);
