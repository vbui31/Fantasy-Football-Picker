export function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(value); value = ""; }
    else if (character === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += character;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  const headers = (rows.shift() || []).map((header) => header.trim().toLowerCase());
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function normalizedName(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
}

export function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildProjectionDataset(rows, players) {
  const playerByKey = new Map(players.map((player) => [`${normalizedName(player.name)}|${player.position}`, player]));
  const priority = { weighted: 3, robust: 2, average: 1 };
  const selected = new Map();
  for (const row of rows) {
    const rawPosition = (row.pos || row.position || "").toUpperCase();
    const position = rawPosition === "DEF" ? "DST" : rawPosition;
    const name = row.full_name || row.player_name || row.player || row.name || `${row.first_name || ""} ${row.last_name || ""}`.trim();
    const points = finiteNumber(row.points ?? row.projection ?? row.projected_points ?? row.fantasy_points);
    if (!name || !position || points === null) continue;
    const key = `${normalizedName(name)}|${position}`;
    const avgType = (row.avg_type || row.average_type || "average").toLowerCase();
    if (!selected.has(key) || (priority[avgType] || 0) > (priority[selected.get(key).avgType] || 0)) selected.set(key, { row, points, avgType });
  }

  const data = {};
  let matches = 0;
  for (const [key, entry] of selected) {
    const player = playerByKey.get(key);
    if (!player) continue;
    const { row, points, avgType } = entry;
    const standardDeviation = finiteNumber(row.sd_pts ?? row.points_sd ?? row.projection_sd);
    const suppliedUncertainty = finiteNumber(row.uncertainty);
    data[player.id] = {
      projection: points,
      floor: finiteNumber(row.floor),
      ceiling: finiteNumber(row.ceiling),
      standardDeviation,
      uncertainty: suppliedUncertainty ?? (standardDeviation !== null && points > 0 ? Math.min(1, standardDeviation / points) : null),
      consensusTier: finiteNumber(row.tier),
      adp: finiteNumber(row.adp ?? row.adp_avg),
      adpDeviation: finiteNumber(row.adp_sd),
      auctionValue: finiteNumber(row.aav ?? row.aav_avg),
      auctionDeviation: finiteNumber(row.aav_sd),
      expertRank: finiteNumber(row.overall_ecr ?? row.ecr ?? row.rank),
      positionExpertRank: finiteNumber(row.pos_ecr ?? row.pos_rank),
      expertRankDeviation: finiteNumber(row.sd_ecr),
      consensusVbd: finiteNumber(row.points_vor),
      floorVbd: finiteNumber(row.floor_vor),
      ceilingVbd: finiteNumber(row.ceiling_vor),
      projectionDropoff: finiteNumber(row.dropoff),
      projectionMethod: avgType
    };
    matches++;
  }

  const first = selected.values().next().value?.row || {};
  return {
    data,
    matches,
    unmatched: Math.max(0, selected.size - matches),
    scoringFormat: first.scoring_format || first.league_type || null,
    generatedAt: first.generated_at_utc || first.generated_at || null,
    projectionMethod: "weighted"
  };
}
