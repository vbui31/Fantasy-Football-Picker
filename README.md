# War Room Fantasy Draft Picker

A dependency-free, browser-based PPR draft assistant built from the supplied NFL player registry. It combines a searchable player board, Monte Carlo rest-of-draft recommendations, adaptive opponents, configurable league intelligence, advanced roster grading, snake/auction simulations, and automatic local saving.

**Live site:** [vbui31.github.io/Fantasy-Football-Picker](https://vbui31.github.io/Fantasy-Football-Picker/)

The production scoring contract is full PPR. The simulator supports animated opponent picks, run-to-your-pick mode, full-draft simulation with pause/resume, league-wide roster grades, adaptive mixtures of six opponent archetypes, and draft state saved in the browser.

## PPR Monte Carlo decision engine

The top three legal recommendations are evaluated across 16 stochastic rest-of-draft paths. Each path completes the room with position-aware opponents, roster constraints, tier value, learned strategy probabilities, and controlled random variation. The recommendation card reports expected weekly PPR starter output, expected matchup win rate, an 80% lineup range, and player-specific survival probabilities at the user's next turn.

The simulation is a decision aid, not a guarantee. Repeated rooms receive different controlled seeds, while a room remains reproducible through its stored state.

## League intelligence

Draft Setup supports:

- public Sleeper league import for team count, roster slots, scoring metadata, keepers, and traded picks;
- manual QB/RB/WR/TE/FLEX/SUPERFLEX/K/DST configuration;
- PPR scoring locked at one point per reception for the current production version;
- optional TE-premium and superflex positional adjustments;
- manual keepers and traded-pick ownership;
- snake drafts and a budget-aware auction value simulation;
- Balanced, Hero RB, WR Core, Robust RB, Elite TE, and Late QB plans.

Replacement levels and roster targets are recalculated for every room. Keepers consume their team's final natural selections, and traded-pick ownership changes the appropriate selection on the clock.

## Feedback

Use the in-app **Send Feedback** link or open a [draft recommendation feedback issue](https://github.com/vbui31/Fantasy-Football-Picker/issues/new?template=draft-feedback.yml). Include the league size, slot, round, roster, observed recommendation, and preferred alternative. Never include private league credentials.

## Run it

```powershell
npm run serve
```

Then open `http://127.0.0.1:4173`.

## Player model

The supplied registry contains identity, roster, search-rank, depth-chart, and injury metadata, but no historical fantasy production or official projections. The included estimates are deliberately labeled and use:

- registry search rank as a market-value proxy;
- depth-chart order as a small starter adjustment;
- position-specific projection curves;
- position-specific replacement baselines for VBD.

They should be treated as a functional draft-board seed, not as real predictive analytics. Replace `projection` and `vbd` in `data/players.json` with trusted projections when available.

## ffanalytics consensus integration

The draft room supports CSV output from [FantasyFootballAnalytics/ffanalytics](https://github.com/FantasyFootballAnalytics/ffanalytics). This improves the picker in five ways:

- combines several public projection sources instead of relying on one registry rank;
- supports ordinary, robust, and source-weighted consensus estimates;
- adds floor, ceiling, tier, and uncertainty signals to distinguish safe picks from volatile ones;
- brings ADP/ECR context into value and reach decisions when those enrichments are available;
- recalculates value over replacement for the selected league size.

The package is an R data pipeline rather than a browser library, so the integration uses a CSV boundary. This keeps the draft room fast, offline-capable, and independent of live scraping failures.

To create a PPR import file (the default):

```powershell
Rscript scripts/export_ffanalytics.R data/ffanalytics-projections.csv
```

Pass `half` or `standard` as the second argument for a different scoring system:

```powershell
Rscript scripts/export_ffanalytics.R data/ffanalytics-projections.csv half
```

When `data/ffanalytics-projections.csv` exists, the app loads it automatically on startup unless a manually imported model is already saved. The export now retains projection ranges and dispersion, ECR, ADP and its dispersion, AAV, package tiers, uncertainty, player information, scoring format, and generation time. Optional upstream enrichments are isolated so one provider failure does not discard the remaining consensus data.

Open **Draft setup → Projection engine → Choose ffanalytics CSV** and select the generated file. The importer accepts the native `projections_table()` fields, prefers `weighted` rows when several averaging methods are present, and matches players by normalized name and position. The registry remains the source for roster status, team, injury, and identity metadata.

## Rebuild the player pool

```powershell
node scripts/build-player-pool.mjs "C:\path\to\player-registry.json"
```

The browser app is static and has no runtime dependencies. Draft state is stored in `localStorage`.

## Daily player context

The committed `data/live-player-context.json` snapshot enriches the board with current Sleeper roster status, injuries, practice participation, depth chart, news-update timestamps, and 24-hour add/drop activity. The updater calls Sleeper's active, position-filtered player endpoint for QB, RB, WR, TE, K, and DEF, then joins the 24-hour trending add and drop endpoints by Sleeper player ID. Prior completed-season player statistics come from nflverse and are used only as a bounded historical cross-check. The nflverse schedule release supplies real team bye weeks for conflict grading. The site disables availability overrides when a snapshot is more than 48 hours old.

Refresh it locally with:

```powershell
npm run refresh:live
```

Sleeper asks clients to download player maps no more than once per day, so the updater keeps a 20-hour cache unless `--force` is supplied. The position filters keep each response smaller than the full player map. GitHub Pages refreshes the deployed snapshot every day. The integration does not claim to provide live game scoring or licensed news text; `newsUpdated` is a timestamp only.

## Mock-draft training

Opponent timing and roster targets use derived calibration constants from prior mock-draft observations. The room rotates Adaptive Value, Hero RB, WR Core, Robust RB, Elite TE, and Late QB profiles, each with soft biases rather than hard scripts. The published calibration delays QB/TE backups and special teams, recognizes tier runs without blindly chasing them, and produces more realistic RB/WR depth.

Every opponent now begins with a probability distribution over those profiles. Each observed pick updates the distribution and behavioral summaries for reach frequency, positional-run following, and ignored roster needs. Results display the dominant inferred style and its confidence instead of treating teams as permanently fixed archetypes.

## Decision model

The picker incorporates the useful concepts from [cbratkovics/fantasy-football-ai](https://github.com/cbratkovics/fantasy-football-ai) without loading its executable pickle artifacts or placeholder prediction API:

- league- and roster-size-aware replacement ranks drive dynamic value above replacement;
- a dependency-free probabilistic clustering pass creates position tiers and tier confidence;
- snake-draft timing and ADP/market rank estimate the chance a player survives until the team's next pick;
- recommendations blend VBD, roster fit, tier depletion, wait risk, projection uncertainty, current availability, bounded historical production, weak market trends, and reach discipline;
- every recommendation exposes its highest-impact factors in the UI.

The calculation lives in `draft-model.js` and produces browser-safe numbers only. It is a decision layer over the current projections, not a claim that registry estimates are a trained forecasting model.

## Grading, backtesting, and learning

Roster grades now compare projected weekly starters, bench VBD, floor/ceiling range, known bye conflicts, injury concentration, QB/pass-catcher correlation, team concentration, positional advantage, and pairwise expected wins. Every league-results card explains the largest components.

The in-app historical evaluation joins completed rosters to bundled prior-season outcomes and reports coverage, recommendation regret, projection MAE, legal-lineup rate, playoff probability, and championship probability by draft slot. It is explicitly labeled exploratory until matching archived draft-time projection and ADP snapshots are provided; future information must never be promoted into production weights.

The repository includes `.codex/skills/fantasy-draft-learning`, a validated skill that defines chronological evaluation, minimum sample sizes, segmentation, and model-promotion gates. It allows room-specific opponent beliefs to adapt immediately while preventing small mock samples from silently rewriting global strategy weights.

## Decision lab and sharing

The interface includes two-player comparison, what-if roster scoring, position scarcity bars, next-turn survival visualization, draft presets, mobile layouts, recommendation feedback controls, shareable room configuration links, and downloadable JSON draft reports.

## Research-derived decision utility

Three supplied academic papers now inform the recommendation layer. The implementation uses the parts that transfer cleanly to a season-long snake draft:

- projection reliability is estimated from consensus dispersion or floor/ceiling range, with explicit injury and rookie cold-start adjustments;
- foundation rounds favor dependable floors, middle rounds balance outcomes, and late rounds put more weight on ceilings;
- roster construction is treated as a constrained optimization problem, so late picks cannot make a complete starting lineup mathematically impossible;
- the app keeps prediction quality separate from draft utility, because lower forecast error did not always produce the strongest constrained teams in the cited experiments;
- future trained projection work should use position-specific models and chronological holdouts rather than random train/test leakage.

The full translation, limitations, and source bibliography are documented in [`docs/research-methodology.md`](docs/research-methodology.md). The PDFs themselves are not redistributed.
