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

### Tier cliffs, draft windows, and upside

The five supplied 2026 strategy guides agree more strongly on process than on exact player order: draft from tiers, stay flexible early, preserve scarce RB/WR depth, use an elite-or-wait approach at tight end, be patient at quarterback in one-QB rooms, take defense late and kicker last, and prefer contingent workload or breakout paths on the bench. These are implemented as transparent score adjustments rather than inflexible round rules. Draft-slot-specific and publisher-specific recommendations remain soft priors because the articles disagree on the exact early-round RB/WR mix.

The late-round utility now rewards ceiling range, rookie/youth uncertainty, and No. 2 depth-chart roles while portfolio logic balances those bets against the reliability of the roster already drafted. Automatic same-team running-back handcuff bonuses are deliberately absent: the behavioral study did not find a meaningful win-rate benefit from that common practice.

### Human opponent behavior

Simulated teams are no longer noisy copies of one ranking. Six repeatable archetypes—Adaptive Value, Hero RB, WR Core, Robust RB, Elite TE, and Late QB—apply soft preferences over the shared value model. Recent position runs create limited urgency, reflecting the study's observed herding, but quarterbacks, kickers, and defenses cannot override the underlying draft-window discipline merely because other teams started a run. This yields varied but still defensible opponents.

### Live metadata and data quality

The daily snapshot uses Sleeper as the current identity/availability layer and nflverse as historical production context. Current injury, practice, roster, and depth-chart fields can materially lower a score; 24-hour add/drop activity is capped as a weak signal. Prior-season PPR pace is capped to a six-point adjustment so it can challenge an estimate without becoming a naive last-year-points ranking.

Quality gates and limits are explicit:

- at least 80% of the bundled registry must match Sleeper or the updater fails;
- availability overrides expire after 48 hours;
- Sleeper's active QB/RB/WR/TE/K/DEF player-map subsets are cached for 20 hours to respect its once-daily guidance and avoid the full 5 MB response;
- nflverse history is not a live scoring feed and will be missing for rookies and some inactive players;
- `newsUpdated` proves only that source metadata changed; no headline content or sentiment is inferred.

## What requires more data

A later training pipeline can add exponentially weighted recent form, opposing-defense and schedule features, position-specific forecasting models, and chronological backtesting. Those signals are intentionally not synthesized from registry rank. When weekly observations become available, evaluate both forecast error (MAE/RMSE) and downstream draft outcomes; the papers show that optimizing one does not guarantee the other.

## Sources

- Roman Lutz, *Fantasy Football Prediction*, arXiv:1505.06918v1 (2015).
- Jonathan Robert Landers and Brian Duperrouzel, *Machine Learning Approaches to Competing in Fantasy Leagues for the NFL*, IEEE Transactions on Games 11(2) (2019).
- Vimal Rajesh, P. Arjun, Kunal Ravikumar Jagtap, Suneera C. M., and Jay Prakash, *Player Recommendation System for Fantasy Premier League using Machine Learning* (JCSSE 2022).
- Footballguys, *2026 Draft Strategy: Rankings, Tiers, and the League-Winning Formula* (2026).
- CBS Sports, *2026 Fantasy football draft strategy: Best approach for every pick* (2026).
- Andrew Anotado, Arash Tavakoli, and Katia Sycara, *Drafting Strategies in Fantasy Football: A Study of Competitive Sequential Human Decision-Making* (2020).
- QB List, *The Ultimate Fantasy Football Draft Guide 2026 – Who To Draft & When* (2026).
- Establish the Run, *Understanding the 2026 fantasy football meta* (2026).
