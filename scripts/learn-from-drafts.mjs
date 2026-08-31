import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const inputDirectory = path.resolve(process.argv[2] || "data/training");
const outputFile = path.resolve(process.argv[3] || "reports/learning-evaluation.json");
let names = [];
try { names = (await readdir(inputDirectory)).filter((name) => name.endsWith(".json")); }
catch { /* An empty training directory is a valid first run. */ }

const reports = [];
const hash = createHash("sha256");
for (const name of names.sort()) {
  const text = await readFile(path.join(inputDirectory, name), "utf8");
  hash.update(name).update(text);
  try {
    const report = JSON.parse(text);
    if (report.schemaVersion === 2 && report.scoring === "PPR" && Array.isArray(report.teams)) reports.push(report);
  } catch { /* Quarantine malformed exports by excluding them from the evaluation. */ }
}

const strategyTotals = {};
let strategyObservations = 0;
let legalTeams = 0;
let teamRecords = 0;
let expectedWins = 0;
let agreements = 0;
let feedback = 0;
for (const report of reports) {
  const requiredStarters = Object.entries(report.settings?.rosterSlots || {}).filter(([key]) => key !== "BENCH").reduce((sum, [, value]) => sum + Number(value || 0), 0);
  for (const team of report.teams) {
    teamRecords++;
    if ((team.evaluation?.starters?.length || 0) >= requiredStarters) legalTeams++;
    expectedWins += Number(team.evaluation?.expectedWins || 0);
  }
  for (const belief of Object.values(report.opponents || {})) {
    for (const [strategy, probability] of Object.entries(belief.probabilities || {})) strategyTotals[strategy] = (strategyTotals[strategy] || 0) + Number(probability || 0);
    strategyObservations++;
  }
  for (const event of report.feedback || []) { feedback++; if (event.sentiment === "agree") agreements++; }
}

const legalLineupRate = teamRecords ? legalTeams / teamRecords : 0;
const enoughRooms = reports.length >= 30;
const report = {
  generatedAt: new Date().toISOString(),
  scoring: "PPR",
  dataFingerprint: reports.length ? hash.digest("hex") : null,
  inputs: { directory: inputDirectory, filesSeen: names.length, validRooms: reports.length },
  baseline: {
    legalLineupRate,
    meanExpectedWinRate: teamRecords ? expectedWins / teamRecords : null,
    recommendationAgreementRate: feedback ? agreements / feedback : null
  },
  candidate: {
    recommendedOpponentPriors: Object.fromEntries(Object.entries(strategyTotals).map(([strategy, total]) => [strategy, total / Math.max(1, strategyObservations)])),
    globalWeightChanges: null
  },
  segments: reports.map((item) => ({ teams: item.settings?.teams, userSlot: item.settings?.userSlot, format: item.settings?.draftFormat, preset: item.settings?.preset })),
  limitations: [
    "Draft exports contain projected roster evaluations; realized season outcomes must be joined separately before global strategy weights can be promoted.",
    "Opponent priors are descriptive until evaluated against held-out rooms."
  ],
  decision: enoughRooms && legalLineupRate === 1 ? "evaluate-candidate-on-held-out-season" : "hold-production-baseline",
  gate: { minimumRooms: 30, enoughRooms, requiresRealizedOutcomes: true, legalLineupRateRequired: 1 }
};

await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Learning evaluation: ${reports.length} valid PPR rooms; decision=${report.decision}; report=${outputFile}`);
