# Data Dictionary — Nurse Unit Census Prediction

This dictionary documents every field consumed or produced by the modeling pipeline.
It is the authoritative reference for the de-identified hourly dataset, the engineered
feature matrix, the prediction targets, and the exported result tables. Field
definitions are sourced from `config/config.yaml` and `src/features/feature_engineering.py`.

- **Grain:** one row per `(NURSE_UNIT_CD, LOCATION_DATE_TIME)` — i.e., per nurse unit per hour.
- **Coverage:** ~157,754 hourly observations across 9 active medical-surgical units, May 2024 – May 2026.
- **Privacy:** de-identified hourly aggregates only; no patient-level identifiers (no HIPAA-protected fields). Unit display names are fictional; real `NURSE_UNIT_CD` codes are operational identifiers.

A note on the **leakage column**: for a forecast at horizon *H*, only information available
at the forecast origin may be used. Each row's lag/rolling/delta features are computed
relative to the row's target timestamp, so a feature with an *N*-hour lookback is excluded
whenever *H > N* (it would otherwise reference the future). The pipeline enforces this with a
horizon-dependent filter, verified by dedicated leakage tests. "All horizons" means the field
is always known in advance (calendar fields and forward-looking schedules).

---

## 1. Identifiers and raw measurements

| Field | Type | Units / Range | Description |
|---|---|---|---|
| `LOCATION_DATE_TIME` | datetime (hourly) | timestamp | Observation hour; the temporal key of every row. |
| `NURSE_UNIT_CD` | categorical (int code) | 9 active units | Nurse unit identifier; each unit is modeled separately. |
| `CENSUS` | integer | patients (≥ 0) | Current patient headcount on the unit at the observation hour. Source signal for the targets. |
| `ED_CENSUS` | integer | patients (≥ 0) | Emergency-department census at the observation hour; upstream driver of inpatient demand. |

## 2. Prediction targets

One target per forecast horizon. The deployed forecaster predicts each separately.

| Field | Type | Horizon | Description |
|---|---|---|---|
| `TARGET_CENSUS_1HR` | integer | +1 h | Unit census one hour ahead. |
| `TARGET_CENSUS_2HR` | integer | +2 h | Unit census two hours ahead. |
| `TARGET_CENSUS_3HR` | integer | +3 h | Unit census three hours ahead. |
| `TARGET_CENSUS_4HR` | integer | +4 h | Unit census four hours ahead. |
| `TARGET_CENSUS_12HR` | integer | +12 h | Unit census twelve hours ahead. |
| `TARGET_CENSUS_24HR` | integer | +24 h | Unit census one day ahead. |
| `TARGET_CENSUS_48HR` | integer | +48 h | Unit census two days ahead. |
| `TARGET_CENSUS_72HR` | integer | +72 h | Unit census three days ahead. |

## 3. Temporal / calendar features (9)

All known in advance → available at every horizon.

| Field | Type | Range | Description |
|---|---|---|---|
| `HOUR_OF_DAY` | integer | 0–23 | Hour of the observation. |
| `DAY_OF_WEEK` | integer | 0–6 | Day of week (Monday = 0). |
| `MONTH_OF_YEAR` | integer | 1–12 | Calendar month. |
| `WEEK_OF_YEAR` | integer | 1–53 | ISO week number. |
| `QUARTER_OF_YEAR` | integer | 1–4 | Calendar quarter. |
| `IS_WEEKEND` | binary | 0/1 | 1 if Saturday or Sunday. |
| `IS_HOLIDAY` | binary | 0/1 | 1 if a U.S. federal holiday. |
| `IS_DAY_BEFORE_HOLIDAY` | binary | 0/1 | 1 if the next day is a holiday. |
| `IS_DAY_AFTER_HOLIDAY` | binary | 0/1 | 1 if the previous day was a holiday. |

## 4. Census history, lags, and rolling statistics (21)

Lag/delta/rolling features are leakage-gated by their lookback window.

| Field | Type | Lookback | Usable when | Description |
|---|---|---|---|---|
| `CENSUS` | integer | 0 h | All horizons | Current census (also a raw measurement). |
| `ED_CENSUS` | integer | 0 h | All horizons | Current ED census. |
| `CENSUS_PREV_1HR` | integer | 1 h | H ≤ 1 | Census one hour earlier. |
| `CENSUS_PREV_2HR` | integer | 2 h | H ≤ 2 | Census two hours earlier. |
| `CENSUS_PREV_3HR` | integer | 3 h | H ≤ 3 | Census three hours earlier. |
| `CENSUS_PREV_4HR` | integer | 4 h | H ≤ 4 | Census four hours earlier. |
| `CENSUS_PREV_12HR` | integer | 12 h | H ≤ 12 | Census twelve hours earlier. |
| `CENSUS_SAME_HOUR_YESTERDAY` | integer | 24 h | H ≤ 24 | Census at the same hour one day earlier (daily seasonality). |
| `CENSUS_PREV_48HR` | integer | 48 h | H ≤ 48 | Census forty-eight hours earlier. |
| `CENSUS_PREV_72HR` | integer | 72 h | H ≤ 72 | Census seventy-two hours earlier. |
| `CENSUS_SAME_HOUR_LAST_WEEK` | integer | 168 h | All horizons (≤ 168) | Census at the same hour one week earlier (weekly seasonality). |
| `CENSUS_DELTA_1HR` | integer | 1 h | H ≤ 1 | Change in census over the prior 1 h. |
| `CENSUS_DELTA_4HR` | integer | 4 h | H ≤ 4 | Change in census over the prior 4 h. |
| `CENSUS_DELTA_12HR` | integer | 12 h | H ≤ 12 | Change in census over the prior 12 h. |
| `CENSUS_DELTA_24HR` | integer | 24 h | H ≤ 24 | Change in census over the prior 24 h. |
| `CENSUS_ROLLING_7DAY_AVG` | float | 7 d | All horizons | Trailing 7-day mean census (level). |
| `CENSUS_ROLLING_7DAY_MAX` | integer | 7 d | All horizons | Trailing 7-day maximum census. |
| `CENSUS_ROLLING_7DAY_MIN` | integer | 7 d | All horizons | Trailing 7-day minimum census. |
| `CENSUS_VS_7DAY_AVG` | float | 7 d | All horizons | Current census minus the trailing 7-day mean (relative position). |
| `IS_CENSUS_SPIKE` | binary | — | All horizons | 1 if current census is an outlier vs. the unit's recent distribution. |
| `DAYS_SINCE_LAST_SPIKE` | integer | — | All horizons | Days since the last census spike. |

## 5. ADT flow features (14)

Admissions, discharges, and transfers — the operational drivers of census change.

| Field | Type | Lookback | Usable when | Description |
|---|---|---|---|---|
| `TOTAL_ADMITS` | integer | 0 h | All horizons | Admissions to the unit in the hour. |
| `TOTAL_TRANSFERS_IN` | integer | 0 h | All horizons | Transfers into the unit in the hour. |
| `TOTAL_DISCHARGES` | integer | 0 h | All horizons | Discharges from the unit in the hour. |
| `TOTAL_TRANSFERS_OUT` | integer | 0 h | All horizons | Transfers out of the unit in the hour. |
| `NET_FLOW` | integer | 0 h | All horizons | (Admits + transfers in) − (discharges + transfers out). |
| `ADMITS_ROLLING_4HR` | float | 4 h | H ≤ 4 | Trailing 4-hour admission rate. |
| `DISCHARGES_ROLLING_4HR` | float | 4 h | H ≤ 4 | Trailing 4-hour discharge rate. |
| `TRANSFERS_IN_ROLLING_4HR` | float | 4 h | H ≤ 4 | Trailing 4-hour transfer-in rate. |
| `TRANSFERS_OUT_ROLLING_4HR` | float | 4 h | H ≤ 4 | Trailing 4-hour transfer-out rate. |
| `ADMITS_ROLLING_8HR` | float | 8 h | H ≤ 8 | Trailing 8-hour admission rate. |
| `DISCHARGES_ROLLING_8HR` | float | 8 h | H ≤ 8 | Trailing 8-hour discharge rate. |
| `ADMITS_ROLLING_24HR` | float | 24 h | H ≤ 24 | Trailing 24-hour admission rate. |
| `DISCHARGES_ROLLING_24HR` | float | 24 h | H ≤ 24 | Trailing 24-hour discharge rate. |
| `NET_FLOW_ROLLING_8HR` | float | 8 h | H ≤ 8 | Trailing 8-hour net flow. |

## 6. Emergency-department features (4)

| Field | Type | Lookback | Usable when | Description |
|---|---|---|---|---|
| `ED_CENSUS_ROLLING_24HR_AVG` | float | 24 h | H ≤ 24 | Trailing 24-hour mean ED census. |
| `ED_CENSUS_ROLLING_24HR_SUM` | float | 24 h | H ≤ 24 | Trailing 24-hour summed ED census. |
| `ED_CENSUS_DELTA_1HR` | integer | 1 h | H ≤ 1 | Change in ED census over the prior 1 h. |
| `ED_CENSUS_DELTA_4HR` | integer | 4 h | H ≤ 4 | Change in ED census over the prior 4 h. |

## 7. Operational / discharge-planning and surgical features (7)

Forward-looking schedules are known in advance → available at all horizons.

| Field | Type | Range | Usable when | Description |
|---|---|---|---|---|
| `TOTAL_DC_ORDERS` | integer | ≥ 0 | All horizons | Discharge orders written in the hour. |
| `PATIENTS_WITH_DC_ORDER` | integer | ≥ 0 | All horizons | Patients with an active discharge order. |
| `PENDING_DC_PRESSURE` | float | ≥ 0 | All horizons | Pending-discharge pressure (queued discharges relative to census). |
| `SCHEDULED_SURGERIES` | integer | ≥ 0 | All horizons | Surgeries scheduled for the unit. |
| `SURGERIES_NEXT_4HR_SCHEDULED` | integer | ≥ 0 | All horizons | Surgeries scheduled in the next 4 hours (forward-looking). |
| `SURGERIES_NEXT_8HR_SCHEDULED` | integer | ≥ 0 | All horizons | Surgeries scheduled in the next 8 hours. |
| `SURGERIES_NEXT_12HR_SCHEDULED` | integer | ≥ 0 | All horizons | Surgeries scheduled in the next 12 hours. |

## 8. Derived cyclical encodings (6)

Sine/cosine encodings keep cyclical fields continuous (so hour 23 and hour 0 are
neighbors). Generated in `src/features/feature_engineering.py`. Available at all horizons.

| Field | Type | Range | Description |
|---|---|---|---|
| `sin_hour`, `cos_hour` | float | [−1, 1] | Cyclical encoding of `HOUR_OF_DAY` (period 24). |
| `sin_day`, `cos_day` | float | [−1, 1] | Cyclical encoding of `DAY_OF_WEEK` (period 7). |
| `sin_month`, `cos_month` | float | [−1, 1] | Cyclical encoding of `MONTH_OF_YEAR` (period 12). |

**Feature count:** 9 temporal + 21 census/lag + 14 ADT + 4 ED + 7 operational + 6 cyclical = **61 engineered features**.

---

## 9. Exported result tables (`outputs/tableau/`)

Key fields produced by the pipeline and consumed by the dashboards.

| File | Grain | Selected fields |
|---|---|---|
| `forecast_predictions.csv` | (timestamp, unit) | `actual_census`, `pred_{H}hr`, `pred_{H}hr_lower`, `pred_{H}hr_upper`, `capacity`, over-capacity flags |
| `executive_summary.csv` | unit | `latest_census`, `capacity`, `utilization_pct`, `forecast_72hr`, `alert_over_90pct` |
| `model_performance_aggregated.csv` | (model, horizon) | `mae`, `rmse`, `mape`, `within_2_patients_pct` |
| `best_model_per_horizon.csv` | horizon | `model`, `within_2_patients_pct`, `mae` |
| `prediction_intervals.json` | (unit, horizon) | `halfwidth`, `q_lower`, `q_upper`, `coverage`, `n`, `val_coverage` |
| `drift_report.csv` / `drift_history.csv` | unit (× time) | `psi`, `psi_residual`, `drift_status`, `alert_kind`, `perf_delta_pct`, `coverage_pct`, `equity_status` |
| `feature_importance.csv` | (unit, horizon, model) | `feature`, `importance`, `rank` |
| `residual_diagnostics.csv` | (model, unit, horizon) | `bias`, `shapiro_wilk_p`, `ljung_box_p` |

*See `config/config.yaml` for the canonical field lists, model hyperparameters, split
dates, and drift/equity thresholds.*
