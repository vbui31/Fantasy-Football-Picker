import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { availabilityAtNextPick, enrichPlayerModel, evidenceProfile, missingStarterSlots, nextPickIndexForTeam, opponentStrategyForTeam, opponentStrategyImpact, replacementRanks, scoreCandidate } from "../draft-model.js";
import { buildProjectionDataset, parseCsv } from "../ffanalytics-data.js";

const ranks = replacementRanks(10, 15);
assert.deepEqual(ranks, { QB: 12, RB: 32, WR: 35, TE: 13, K: 10, DST: 10 });
assert.equal(nextPickIndexForTeam(4, 4, 10, 150), 15, "middle pick should return in round two");
assert.equal(nextPickIndexForTeam(0, 0, 10, 150), 19, "first pick should wait through the turn");

const players = Array.from({ length: 45 }, (_, index) => ({
  id: `rb-${index}`,
  name: `Runner ${index}`,
  position: "RB",
  projection: 300 - index * (index === 8 ? 3 : 2),
  sourceRank: index + 1,
  adp: index + 1
}));
enrichPlayerModel(players, { teams: 10, rounds: 15 });
assert.equal(players[31].vbd, 0, "RB32 should be the ten-team replacement player");
assert.ok(players[0].tier <= players[20].tier, "better projections should not receive a worse tier");
assert.ok(players.every((player) => Number.isFinite(player.tierProbability)), "every modeled player needs tier confidence");

const early = availabilityAtNextPick({ adp: 5 }, 0, 19);
const late = availabilityAtNextPick({ adp: 45 }, 0, 19);
assert.ok(early < late, "early ADP player should be less likely to survive");

const profile = { targetRoster: { QB: 1.7, RB: 4.2, WR: 5.4, TE: 1.7 }, medianFirstRound: { QB: 7, TE: 7, K: 15, DST: 14 } };
const decision = scoreCandidate(players[0], { roster: [], round: 0, currentPickIndex: 0, nextPickIndex: 19, availablePlayers: players, profile });
assert.ok(Number.isFinite(decision.score));
assert.ok(decision.factors.some((factor) => factor.label === "Wait risk"));

const stable = { projection: 200, floor: 185, ceiling: 215, uncertainty: .08, yearsExperience: 4, modelSource: "ffanalytics" };
const volatile = { projection: 200, floor: 140, ceiling: 260, uncertainty: .3, yearsExperience: 4, modelSource: "ffanalytics" };
assert.ok(evidenceProfile(stable, 1, 15).impact > evidenceProfile(volatile, 1, 15).impact, "foundation rounds should prefer reliable floors");
assert.ok(evidenceProfile(volatile, 13, 15).impact > evidenceProfile(stable, 13, 15).impact, "late rounds should give volatile ceilings more utility");
assert.ok(evidenceProfile({ ...stable, yearsExperience: 0 }, 1, 15).reliability < evidenceProfile(stable, 1, 15).reliability, "rookies should receive a cold-start confidence adjustment");
assert.equal(missingStarterSlots({ QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 }), 2, "a base lineup still needs two flex starters");

const nearlyCompleteRoster = [
  { position: "QB" }, { position: "RB" }, { position: "RB" }, { position: "RB" }, { position: "RB" }, { position: "RB" },
  { position: "WR" }, { position: "WR" }, { position: "WR" }, { position: "WR" }, { position: "WR" },
  { position: "TE" }, { position: "TE" }, { position: "K" }
];
const finalBase = { projection: 100, vbd: 0, tier: 1, tierDropoff: 0, tierProbability: .8, sourceRank: 150, yearsExperience: 3 };
const dstDecision = scoreCandidate({ ...finalBase, id: "dst", position: "DST" }, { roster: nearlyCompleteRoster, round: 14, currentPickIndex: 149, nextPickIndex: null, availablePlayers: [{ ...finalBase, id: "dst", position: "DST" }], profile, totalRounds: 15 });
const rbDecision = scoreCandidate({ ...finalBase, id: "extra-rb", position: "RB" }, { roster: nearlyCompleteRoster, round: 14, currentPickIndex: 149, nextPickIndex: null, availablePlayers: [{ ...finalBase, id: "extra-rb", position: "RB" }], profile, totalRounds: 15 });
assert.ok(dstDecision.score > rbDecision.score + 500, "final-pick feasibility should force the missing defense");

const strategicBase = { projection: 185, vbd: 20, tier: 2, tierDropoff: 4, tierProbability: .75, sourceRank: 40, adp: 40, yearsExperience: 3 };
const earlyKicker = scoreCandidate({ ...strategicBase, id: "k", position: "K" }, { roster: [], round: 2, currentPickIndex: 20, nextPickIndex: 39, availablePlayers: [{ ...strategicBase, id: "k", position: "K" }], profile, totalRounds: 15 });
assert.ok(earlyKicker.factors.some((factor) => factor.label === "Draft window" && factor.impact <= -100), "kicker must be reserved for the final round");
const unavailable = scoreCandidate({ ...strategicBase, id: "out-rb", position: "RB", liveStatus: "active", injury: "Out" }, { roster: [], round: 1, currentPickIndex: 10, nextPickIndex: 29, availablePlayers: [{ ...strategicBase, id: "out-rb", position: "RB" }], profile, totalRounds: 15 });
const healthy = scoreCandidate({ ...strategicBase, id: "healthy-rb", position: "RB" }, { roster: [], round: 1, currentPickIndex: 10, nextPickIndex: 29, availablePlayers: [{ ...strategicBase, id: "healthy-rb", position: "RB" }], profile, totalRounds: 15 });
assert.ok(unavailable.score < healthy.score - 45, "a current Out designation must materially lower the recommendation");
const upside = scoreCandidate({ ...strategicBase, id: "rookie-rb", position: "RB", yearsExperience: 0, depthOrder: 2, floor: 110, ceiling: 270 }, { roster: Array.from({ length: 7 }, (_, index) => ({ ...strategicBase, id: `roster-${index}`, position: index % 2 ? "WR" : "RB" })), round: 9, currentPickIndex: 90, nextPickIndex: 109, availablePlayers: [{ ...strategicBase, id: "rookie-rb", position: "RB", yearsExperience: 0, depthOrder: 2, floor: 110, ceiling: 270 }], profile, totalRounds: 15 });
assert.ok(upside.factors.some((factor) => factor.label === "Bench upside" && factor.impact >= 7), "late-round contingent rookies should receive an upside signal");
assert.equal(new Set(Array.from({ length: 6 }, (_, team) => opponentStrategyForTeam(team).id)).size, 6, "the room should contain six distinct opponent archetypes");
const wrCore = opponentStrategyImpact({ position: "WR", tier: 2 }, { roster: [], round: 2, team: 2, recentPicks: [] });
const wrCoreRb = opponentStrategyImpact({ position: "RB", tier: 2 }, { roster: [], round: 2, team: 2, recentPicks: [] });
assert.ok(wrCore.impact > wrCoreRb.impact, "WR Core opponents should prefer early receivers");
const lateQb = opponentStrategyImpact({ position: "QB", tier: 1 }, { roster: [], round: 3, team: 5, recentPicks: [] });
assert.ok(lateQb.impact < 0, "Late QB opponents should resist early quarterbacks");

const sampleRows = parseCsv(await readFile(new URL("../examples/ffanalytics-sample.csv", import.meta.url), "utf8"));
const samplePlayers = [
  { id: "bijan", name: "Bijan Robinson", position: "RB" },
  { id: "allen", name: "Josh Allen", position: "QB" }
];
const imported = buildProjectionDataset(sampleRows, samplePlayers);
assert.equal(imported.matches, 2);
assert.equal(imported.data.bijan.projection, 301.5, "weighted consensus should win over average");
assert.equal(imported.data.bijan.standardDeviation, 16.4);
assert.equal(imported.data.allen.expertRank, 8);

console.log("Decision model self-test passed.");
