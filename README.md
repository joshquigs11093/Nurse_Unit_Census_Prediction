# Predictive Census Modeling for Hospital Nurse Unit Capacity Planning

**Author:** Josh Quigley
**Program:** M.S. Data Science -- Grand Canyon University

## What This Project Does

Predicts patient census (headcount) on medical-surgical nurse units at multiple time horizons:
- **1-4 hours** -- real-time staffing adjustments
- **12 hours** -- upcoming shift planning
- **24 hours** -- next-day scheduling
- **48-72 hours** -- strategic capacity planning

The goal is **+-2 patient accuracy per unit** using historical admissions, discharges, transfers (ADT), and features like ED volume, surgical schedules, and seasonal patterns.

## Why It Matters

Hospitals guess at staffing. Understaffing burns out nurses and hurts patients. Overstaffing wastes money. This project replaces guesswork with data-driven forecasts delivered through Tableau dashboards for house supervisors, process improvement teams, and leadership.

## Models Being Compared

| Model | Type | Library |
|-------|------|---------|
| ARIMA | Statistical time series | statsmodels |
| Prophet | Seasonal decomposition | prophet |
| LSTM | Deep learning (sequence) | TensorFlow/Keras |
| Random Forest | Tree-based ensemble | scikit-learn |
| LightGBM | Gradient boosting | lightgbm |
| Ensemble | Combined best models | Custom |

## Folder Structure

```
Nurse_Unit_Census_Prediction/
|
|-- data/                    # All datasets (raw, processed, external) -- NOT committed to git
|-- docs/                    # Project documentation, proposal, references
|-- notebooks/               # Jupyter notebooks for EDA, experiments, prototyping
|-- outputs/
|   |-- figures/             # Charts, plots, visualizations
|   |-- reports/             # Generated analysis reports, metrics tables
|-- src/
|   |-- data/                # Scripts for data loading, cleaning, transformation
|   |-- features/            # Feature engineering (temporal features, lag variables, etc.)
|   |-- models/              # Model training, evaluation, and prediction scripts
|   |-- utils/               # Shared helpers (config, logging, metrics, etc.)
|-- .gitignore               # Excludes data files, .env, model artifacts, .venv
|-- requirements.txt         # Python dependencies
|-- README.md                # This file
```

## Data

Data access is pending organizational approval. Alternatives if not available:
- **MIMIC-IV** -- public de-identified hospital dataset (requires PhysioNet credentialing)
- **Synthetic data** -- generated to match published hospital census distributions

**No patient data is committed to this repo.** The `data/` folder is in `.gitignore`.

## Getting Started

**Requirements:** Python 3.9+, 16GB RAM minimum (32GB recommended for LSTM)

```bash
# Clone the repo
git clone https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction.git
cd Nurse_Unit_Census_Prediction

# Create virtual environment
python -m venv .venv

# Activate it
# Windows:
.venv\Scripts\activate
# Mac/Linux:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

> **Note:** `requirements.txt` will be updated as development progresses. Additional packages (prophet, tensorflow, lightgbm, statsmodels) will be added in later milestones.

## Evaluation Metrics

All models are evaluated per forecast horizon using:
- **MAE** -- Mean Absolute Error
- **RMSE** -- Root Mean Squared Error
- **MAPE** -- Mean Absolute Percentage Error
- **% within +-2 patients** -- primary success metric

## Tableau Dashboards (Planned)

Three dashboards targeting different audiences:
1. **Operational Forecast** -- house supervisors see current + predicted census with confidence intervals
2. **Model Performance** -- process improvement team tracks accuracy over time
3. **Executive Summary** -- leadership views capacity trends across all units

## Project Timeline

| Milestone | Course | What | When |
|-----------|--------|------|------|
| 1 - Proposal & Requirements | CST-560 | Project scope, use cases, data pipeline design | Jan 2026 |
| 2 - Pipeline Design | DSC-570 | Model architecture, preprocessing pipeline, dashboard wireframes | Mar 2026 |
| 3 - Implementation | DSC-580 | Working code, trained models, Tableau dashboards | May 2026 |
| 4 - Evaluation & Presentation | DSC-590 | Performance analysis, final report, presentation video | Jul 2026 |

## Security & Privacy

- All data is de-identified (HIPAA Safe Harbor compliant)
- No PHI is stored in this repository
- `.gitignore` excludes `data/`, `.env`, and model artifacts
- Tableau Public dashboards show only aggregated outputs
