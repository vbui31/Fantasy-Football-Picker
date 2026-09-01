export function parseTradedPicks(text, teams, rounds) {
  const teamCount = Number(teams);
  const roundCount = Number(rounds);
  if (!Number.isInteger(teamCount) || teamCount < 1 || !Number.isInteger(roundCount) || roundCount < 1) return {};

  const traded = {};
  const maxPicks = teamCount * roundCount;
  for (const line of String(text || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^(\d+)\s*:\s*Team\s+(\d+)$/i);
    if (!match) continue;
    const overall = Number(match[1]);
    const team = Number(match[2]) - 1;
    if (overall >= 1 && overall <= maxPicks && team >= 0 && team < teamCount) traded[overall] = team;
  }
  return traded;
}
