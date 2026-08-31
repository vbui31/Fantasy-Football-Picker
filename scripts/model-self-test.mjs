import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { availabilityAtNextPick, enrichPlayerModel, evidenceProfile, missingStarterSlots, nextPickIndexForTeam, opponentStrategyForTeam, opponentStrategyImpact, replacementRanks, scoreCandidate } from "../draft-model.js";
import { buildProjectionDataset, parseCsv } from "../ffanalytics-data.js";
import { createOpponentBeliefs, dominantOpponentStyle, evaluateRoster, normalizeLeagueSettings, runMonteCarloRestOfDraft, updateOpponentBelief } from "../draft-intelligence.js";
import { historicalCalibration, settingsFingerprint, validateExternalGradeResponse } from "../draft-audit.js";

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

const pprSettings = normalizeLeagueSettings({ teams: 10, rounds: 15, rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, SUPERFLEX: 0, K: 1, DST: 1 } });
assert.equal(pprSettings.scoring.reception, 1, "the production scoring contract must remain full PPR");
const superflexSettings = normalizeLeagueSettings({ teams: 10, rounds: 16, rosterSlots: { ...pprSettings.rosterSlots, SUPERFLEX: 1 } });
assert.equal(superflexSettings.superflex, true);
assert.ok(replacementRanks(10, 16, superflexSettings.rosterSlots).QB > replacementRanks(10, 16).QB, "superflex must raise quarterback replacement demand");

const gradeRoster = [
  { id: "q", position: "QB", projection: 340, floor: 300, ceiling: 380, team: "BUF", byeWeek: 7 },
  { id: "r1", position: "RB", projection: 280, floor: 230, ceiling: 330, team: "ATL", vbd: 90, byeWeek: 5 },
  { id: "r2", position: "RB", projection: 250, team: "DET", vbd: 60, byeWeek: 8 },
  { id: "w1", position: "WR", projection: 270, team: "BUF", vbd: 70, byeWeek: 7 },
  { id: "w2", position: "WR", projection: 245, team: "MIN", vbd: 50, byeWeek: 6 },
  { id: "t", position: "TE", projection: 210, team: "LV", vbd: 45, byeWeek: 8 },
  { id: "f1", position: "WR", projection: 220, team: "LAR", vbd: 30, byeWeek: 9 },
  { id: "f2", position: "RB", projection: 215, team: "SEA", vbd: 25, byeWeek: 8 },
  { id: "k", position: "K", projection: 130, team: "DAL", byeWeek: 10 },
  { id: "d", position: "DST", projection: 120, team: "BAL", byeWeek: 7 }
];
const grade = evaluateRoster(gradeRoster, pprSettings, [gradeRoster, gradeRoster.map((player) => ({ ...player, projection: player.projection * .92 }))]);
assert.ok(grade.weekly > 100, "advanced grading should calculate weekly PPR starter output");
assert.ok(grade.correlation > 0, "QB/pass-catcher stacks should be recognized");
assert.equal(grade.unknownByes, 0, "known bye weeks should produce complete conflict coverage");

let belief = createOpponentBeliefs(2, 0)[1];
belief = updateOpponentBelief(belief, { player: { position: "WR", tier: 1, vbd: 80, adp: 5 }, rosterBefore: [], round: 0, pickNumber: 5, recentPicks: [] });
belief = updateOpponentBelief(belief, { player: { position: "WR", tier: 1, vbd: 70, adp: 15 }, rosterBefore: [{ position: "WR" }], round: 1, pickNumber: 15, recentPicks: [] });
assert.equal(dominantOpponentStyle(belief).id, "wr-core", "opponent beliefs should learn a repeated early-WR tendency");

const mcPlayers = Array.from({ length: 80 }, (_, index) => ({ id: `mc-${index}`, name: `MC ${index}`, position: ["RB", "WR", "QB", "TE", "K", "DST"][index % 6], projection: 300 - index, vbd: 100 - index, tier: 1 + Math.floor(index / 20) }));
const mc = runMonteCarloRestOfDraft({ candidateIds: ["mc-0", "mc-1"], watchPlayerIds: ["mc-1"], availablePlayers: mcPlayers, rosters: Array.from({ length: 4 }, () => []), currentPickIndex: 0, currentTeam: 0, settings: normalizeLeagueSettings({ teams: 4, rounds: 5, rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 1, SUPERFLEX: 0, K: 0, DST: 0 } }), simulations: 8, seed: 42 });
assert.equal(mc["mc-0"].simulations, 8);
assert.ok(Number.isFinite(mc["mc-0"].expectedWeekly), "Monte Carlo must return a finite completed-roster expectation");
assert.ok(mc["mc-0"].survival["mc-1"] >= 0 && mc["mc-0"].survival["mc-1"] <= 1, "next-turn survival must be calibrated as a probability");

const auditSettings = normalizeLeagueSettings({ teams: 4, rounds: 5, rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 1, SUPERFLEX: 0, K: 0, DST: 0 } });
const external = validateExternalGradeResponse({ provider: "Independent projections", modelVersion: "1", gradedAt: "2026-08-31T00:00:00Z", methodology: "Separate PPR model", teams: Array.from({ length: 4 }, (_, team) => ({ team, score: 80 - team * 5, grade: ["A", "B+", "B", "C+"][team], confidence: .8, explanation: ["Deterministic projection score"] })) }, 4);
assert.equal(external.teams.length, 4, "external graders must return one valid grade per team");
assert.throws(() => validateExternalGradeResponse({ provider: "test", modelVersion: "1", methodology: "test", teams: [{ team: 0, score: 140 }] }, 1), /0 to 100/, "out-of-range external scores must be rejected");
assert.throws(() => validateExternalGradeResponse({ teams: [{ team: 0, score: 80 }] }, 1), /provider, model version, and methodology/, "anonymous external grades must be rejected");
const auditFingerprint = settingsFingerprint(auditSettings);
const calibration = historicalCalibration(120, [{ id: "old-1", status: "complete", settingsFingerprint: auditFingerprint, userScore: 100 }, { id: "old-2", status: "complete", settingsFingerprint: auditFingerprint, userScore: 110 }], auditSettings, "current");
assert.equal(calibration.percentile, 1, "past grades should calibrate current results only against matching completed rooms");

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
