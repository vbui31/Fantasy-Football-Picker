const finite = (...values) => values.map(Number).find(Number.isFinite);
const averageFinite = (values) => {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
};

export function providerPosition(record = {}) {
  return String(record.position_id || record.Position || record.FantasyPosition || record.position || "").toUpperCase().replace("DEF", "DST");
}

export function providerTeam(record = {}) {
  return String(record.team_id || record.Team || record.team || "").toUpperCase();
}

export function providerName(record = {}) {
  return String(record.name || record.Name || record.player_name || "").trim();
}

const plausibleProjection = (value, position) => {
  if (!Number.isFinite(value) || value < 0) return null;
  const limit = ["K", "DST"].includes(position) ? 300 : 650;
  return value <= limit ? value : null;
};

const plausibleAdp = (value) => Number.isFinite(value) && value >= 1 && value <= 500 ? value : null;

export function normalizeFantasyProsProjection(record = {}) {
  const stats = Array.isArray(record.stats) ? record.stats : [record.stats || {}];
  const pprValues = stats.map((entry) => entry?.points_ppr).filter((value) => Number.isFinite(Number(value)));
  const projection = pprValues.length ? averageFinite(pprValues) : averageFinite(stats.map((entry) => entry?.points));
  return {
    projection: plausibleProjection(projection, providerPosition(record)),
    adp: plausibleAdp(finite(record.rank_ecr, record.rank, record.adp)),
    providerPlayerId: record.fpid || record.player_id || null
  };
}

export function normalizeSportsDataProjection(record = {}) {
  return {
    projection: plausibleProjection(finite(record.FantasyPointsPPR, record.ProjectedFantasyPoints, record.FantasyPoints), providerPosition(record)),
    adp: plausibleAdp(finite(record.AverageDraftPositionPPR, record.AverageDraftPosition)),
    auctionValue: finite(record.AuctionValuePPR, record.AuctionValue),
    providerPlayerId: record.PlayerID || null
  };
}
