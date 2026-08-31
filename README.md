# War Room Fantasy Draft Picker

A dependency-free, browser-based snake draft assistant built from the supplied NFL player registry. It combines a searchable player board, value-based recommendations, roster construction signals, simulated opponent picks, undo, and automatic local saving.

**Live site:** [vbui31.github.io/Fantasy-Football-Picker](https://vbui31.github.io/Fantasy-Football-Picker/)

The simulator supports animated opponent picks, run-to-your-pick mode, full-draft simulation with pause/resume, league-wide roster grades, and draft state saved in the browser.

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

## Mock-draft training

Opponent timing and roster targets use derived calibration constants from prior mock-draft observations. The raw research notes and captured simulation profiles stay local and are intentionally excluded from the public website. The published calibration delays QB/TE backups and special teams while producing more realistic RB/WR depth.

## Decision model

The picker incorporates the useful concepts from [cbratkovics/fantasy-football-ai](https://github.com/cbratkovics/fantasy-football-ai) without loading its executable pickle artifacts or placeholder prediction API:

- league- and roster-size-aware replacement ranks drive dynamic value above replacement;
- a dependency-free probabilistic clustering pass creates position tiers and tier confidence;
- snake-draft timing and ADP/market rank estimate the chance a player survives until the team's next pick;
- recommendations blend VBD, roster fit, tier depletion, wait risk, projection uncertainty, injury status, and reach discipline;
- every recommendation exposes its highest-impact factors in the UI.

The calculation lives in `draft-model.js` and produces browser-safe numbers only. It is a decision layer over the current projections, not a claim that registry estimates are a trained forecasting model.
