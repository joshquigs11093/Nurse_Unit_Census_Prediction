# Changelog

All notable changes to the Nurse Unit Census Prediction project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); versions group the
project's major refinements. Dates reflect the commit history on the `main` branch.
(Routine automated "daily forecast refresh" commits are omitted for clarity.)

Capstone milestone mapping: **Planning** → v0.1, **Design/Implementation** → v0.1–v0.2,
**Analysis & refinement** → v0.3–v0.5, **Completion (Benchmark Final)** → v1.0.

## [1.0.0] — 2026-07-01 — Completion phase (Benchmark Final Project)
### Added
- Technical Audit, 1,000–1,250-word Scientific Report, and 9-slide Presentation
  (`docs/Benchmark_Final_Project/`), generated reproducibly from `scripts/`.
- Verified reference pool (`scripts/final_references.py`): every source confirmed to have
  a resolvable DOI and open-access status via the OpenAlex API; APA-7 compliant.
- This data dictionary (`docs/DATA_DICTIONARY.md`) and version history (`CHANGELOG.md`).
### Changed
- Swapped paywalled/no-DOI citations for verified open-access equivalents.

## [0.5.0] — 2026-06-19 — Statistical rigor
### Added
- Forecast significance testing: paired Diebold-Mariano test (Harvey-Leybourne-Newbold
  small-sample correction) on the per-horizon best model vs. runner-up.
- Residual diagnostics: Shapiro-Wilk normality and Ljung-Box autocorrelation per fit,
  surfaced on the methodology page.
### Changed
- Widened prediction intervals from 90% to **95%** coverage; synthetic forecast bands now
  driven by the calibrated split-conformal intervals; interval labels corrected across all
  dashboards.

## [0.4.0] — 2026-05-30 — In-repo dashboards, explainability, and equity
### Added
- Per-unit, per-horizon **explainability page** (feature importance).
- **Equity / fairness** view on the monitor (flags underserved units).
- Seasonality-aware drift signals (STL-deseasoned PSI, persistence gate, systemic flag).
- Hover tooltips and dashboard screenshots wired into the gallery.
### Changed
- Replaced the three Tableau Public dashboards with self-contained in-repo Plotly pages
  (Operational, Model Performance, Executive Summary); removed the Tableau dependency.

## [0.3.0] — 2026-05-22 — Uncertainty quantification and drift monitoring
### Added
- Split-conformal **prediction intervals** derived from validation residuals.
- **Drift monitoring** (Population Stability Index + within-2 performance drift vs. a frozen
  training baseline) and a monitoring page with drift-over-time and interval bands.

## [0.2.0] — 2026-05-05 — Testing and continuous integration
### Added
- Automated **test suite** surfaced on a GitHub Pages tests page with a CI status badge.
- GitHub Actions workflow running the data-free test subset on every push.
- README updated with the tests page, CI badge, and data-free subset command.

## [0.1.0] — 2026-05-04 — Initial implementation and deployment
### Added
- End-to-end pipeline: data cleaning/validation, leakage-safe feature engineering,
  per-unit/per-horizon training of five model families (ARIMA, Prophet, LSTM, Random
  Forest, LightGBM) plus an inverse-error weighted ensemble.
- Synthetic hourly data generator and a daily GitHub Actions refresh cron.
- Multi-page GitHub Pages site: landing, model cards, methodology, dashboards gallery.
- CSV/JSON exports for dashboard consumption; long-format `forecast_timeline.csv`.

[1.0.0]: https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction
[0.5.0]: https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction
[0.4.0]: https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction
[0.3.0]: https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction
[0.2.0]: https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction
[0.1.0]: https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction
