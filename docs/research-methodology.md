# Research methodology

The draft picker applies a research-derived decision layer over its projection source. It does not claim that the browser has trained the support-vector, neural-network, random-forest, or boosted-tree models described in the papers. Those models require historical weekly observations that are not bundled with this static site.

## What is implemented

### Evidence reliability

Projection uncertainty is normalized from ffanalytics uncertainty, standard deviation, or the supplied floor/ceiling interval. Reliability is reduced for current injury designations and for rookies with no NFL history. Registry-only projections receive a conservative default uncertainty rather than being presented as certain.

This follows Lutz's treatment of first-year players as a cold-start problem and the Landers–Duperrouzel finding that filtering for lower variance and useful ceilings improved selected-team outcomes even when raw regression fit was lower.

### Draft-phase utility

The model converts floor, mean projection, and ceiling into a phase-aware utility estimate:

- foundation rounds: 42% floor, 53% mean, 5% ceiling;
- balance rounds: 20% floor, 60% mean, 20% ceiling;
- upside rounds: 8% floor, 47% mean, 45% ceiling.

These are transparent product weights inspired by the papers, not coefficients reported by them. They make the intended behavior inspectable: protect early-round capital, then accept more variance when bench upside has greater value.

### Constrained roster construction

Before scoring a candidate, the picker calculates the minimum number of selections still needed to fill QB, two RB, two WR, TE, two FLEX, K, and DST. A candidate is rejected if selecting that player would make a legal starting lineup impossible with the picks remaining. Required positions receive an urgency boost when the roster reaches the feasibility boundary.

This adapts the prediction-then-optimization architecture used in both the NFL daily-fantasy and FPL recommendation papers to a sequential snake draft.

## What requires more data

A later training pipeline can add exponentially weighted recent form, opposing-defense and schedule features, position-specific forecasting models, and chronological backtesting. Those signals are intentionally not synthesized from registry rank. When weekly observations become available, evaluate both forecast error (MAE/RMSE) and downstream draft outcomes; the papers show that optimizing one does not guarantee the other.

## Sources

- Roman Lutz, *Fantasy Football Prediction*, arXiv:1505.06918v1 (2015).
- Jonathan Robert Landers and Brian Duperrouzel, *Machine Learning Approaches to Competing in Fantasy Leagues for the NFL*, IEEE Transactions on Games 11(2) (2019).
- Vimal Rajesh, P. Arjun, Kunal Ravikumar Jagtap, Suneera C. M., and Jay Prakash, *Player Recommendation System for Fantasy Premier League using Machine Learning* (JCSSE 2022).
