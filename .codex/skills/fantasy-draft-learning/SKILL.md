---
name: fantasy-draft-learning
description: Improve fantasy-football draft recommendations from completed drafts, historical outcomes, and projection updates using leakage-safe evaluation and controlled model promotion. Use when tuning, backtesting, or learning from draft feedback; do not use to invent missing outcomes or silently replace the production baseline.
---

# Fantasy Draft Learning

Improve the drafter through reproducible evidence rather than one-off preference changes.

## Workflow

1. Identify whether the input is a projection snapshot, completed draft, recommendation decision, feedback event, or realized season outcome.
2. Preserve the timestamp and source. Never join a draft-time decision to information published after that decision except as the labeled outcome.
3. Evaluate the existing production configuration as the baseline before tuning.
4. Use chronological or season-held-out validation. Report performance by draft slot, team count, and format; do not rely on aggregate accuracy alone.
5. Tune bounded, interpretable parameters first: archetype probabilities, availability curves, tier urgency, uncertainty penalties, and roster utility weights.
6. Promote a change only when it improves downstream roster outcomes without materially worsening calibration or lineup feasibility.
7. Record the candidate configuration, dataset fingerprint, metrics, and promotion decision in a machine-readable report.

Read [references/evaluation-contract.md](references/evaluation-contract.md) before changing production weights or accepting a backtest result.

## Guardrails

- Keep PPR as the production scoring contract until the project explicitly enables another scoring model.
- Treat injury/news metadata as opportunity and uncertainty evidence, not deterministic sentiment.
- Do not learn from fewer than 30 completed rooms without marking the result exploratory.
- Never optimize on championship rate alone; include projection calibration, recommendation regret, expected wins, and roster feasibility.
- Retain the prior configuration so a promoted model can be rolled back.
