# Evaluation contract

## Required inputs

- Draft-time projection snapshot and ADP/ECR snapshot.
- League configuration and exact pick order, including keepers or traded picks.
- Recommendation candidates with scores and availability estimates.
- Completed rosters.
- Realized player outcomes when evaluating season performance.

Each record needs a source, season, and `observedAt` timestamp. Reject or quarantine records with missing identity joins, impossible picks, duplicate player selections, or future information in draft-time features.

## Baseline and candidate metrics

Compare the production baseline and candidate on identical held-out rooms:

- mean and median points above replacement;
- recommendation regret versus the best later-observable legal choice;
- availability calibration by probability decile;
- projected and realized weekly starter points;
- playoff and championship probability with uncertainty intervals;
- legal-lineup completion rate;
- results by draft slot, room size, and opponent archetype.

## Promotion gate

A candidate is eligible only when it has at least 30 completed rooms, no future-data leakage, a 100% legal-lineup completion rate, and either:

- at least a 2% expected-win improvement with no calibration regression over two percentage points; or
- statistically credible regret reduction across a held-out season.

Small samples may update per-room opponent beliefs but must not rewrite global production weights.

Write reports as JSON containing `baseline`, `candidate`, `segments`, `dataFingerprint`, `limitations`, and `decision`.
