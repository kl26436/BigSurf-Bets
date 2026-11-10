# Backtest — 2026 weeks 1–9

Trained on 2021–2025 (35,856 player-games, 218 features); scored on 3,448 player-games the model never saw.

## DraftKings points (fantasy-relevant players)

| Pos | n | Model MAE | Best naive MAE | Improvement | Bias | Rank corr (model / naive) | 80% band covers | 50% band covers |
|---|---|---|---|---|---|---|---|---|
| QB | 302 | 6.26 | 6.87 (recent avg) | +8.9% | +0.34 | 0.480 / 0.444 | 77% | 50% |
| RB | 438 | 5.77 | 6.11 (recent avg) | +5.5% | -0.14 | 0.570 / 0.512 | 84% | 51% |
| WR | 685 | 5.71 | 5.98 (recent avg) | +4.5% | -0.09 | 0.545 / 0.472 | 84% | 55% |
| TE | 319 | 5.42 | 5.55 (recent avg) | +2.4% | +0.07 | 0.319 / 0.296 | 78% | 43% |
| ALL | 1,744 | 5.77 | 6.09 (recent avg) | +5.3% | +0.00 | 0.582 / 0.511 | 82% | 51% |

## PPR points (fantasy-relevant players)

| Pos | n | Model MAE | Best naive MAE | Improvement | Rank corr (model / naive) |
|---|---|---|---|---|---|
| QB | 300 | 5.98 | 6.54 | +8.7% | 0.476 / 0.430 |
| RB | 433 | 5.51 | 5.80 | +4.9% | 0.561 / 0.508 |
| WR | 681 | 5.38 | 5.63 | +4.5% | 0.539 / 0.463 |
| TE | 318 | 5.32 | 5.42 | +1.9% | 0.322 / 0.300 |
| ALL | 1,732 | 5.50 | 5.79 | +5.0% | 0.564 / 0.497 |

## Stat projections — mean absolute error

| Stat | n | Model | Recent avg (EWMA) | Last 4 | Season avg | Model vs best naive |
|---|---|---|---|---|---|---|
| attempts | 312 | 6.561 | 8.606 | 9.077 | 8.876 | -23.8% |
| completions | 312 | 4.457 | 5.741 | 6.056 | 5.856 | -22.4% |
| passing_yards | 312 | 57.309 | 68.357 | 72.443 | 73.199 | -16.2% |
| passing_tds | 312 | 0.819 | 0.856 | 0.903 | 0.940 | -4.3% |
| interceptions | 312 | 0.604 | 0.647 | 0.666 | 0.626 | -3.5% |
| carries | 3,354 | 0.983 | 1.072 | 1.081 | 1.069 | -8.0% |
| rushing_yards | 3,354 | 5.642 | 5.952 | 6.125 | 6.018 | -5.2% |
| rushing_tds | 3,354 | 0.101 | 0.101 | 0.099 | 0.102 | +2.5% |
| targets | 3,042 | 1.446 | 1.517 | 1.567 | 1.558 | -4.7% |
| receptions | 3,042 | 1.124 | 1.151 | 1.193 | 1.199 | -2.3% |
| receiving_yards | 3,042 | 14.512 | 14.818 | 15.439 | 15.533 | -2.1% |
| receiving_tds | 3,042 | 0.203 | 0.207 | 0.204 | 0.207 | -0.6% |

## Over/under probabilities — reliability

Synthetic lines at 75% / 100% / 125% of each listed player's recent average. A calibrated model's *actual* column matches *predicted*.

| Model said P(over) | n | Predicted | Actual |
|---|---|---|---|
| 0%–20% | 1,698 | 13.9% | 14.6% |
| 20%–30% | 2,649 | 25.4% | 25.7% |
| 30%–40% | 3,132 | 35.0% | 34.9% |
| 40%–50% | 3,007 | 44.9% | 45.9% |
| 50%–60% | 2,173 | 54.9% | 56.0% |
| 60%–70% | 1,808 | 64.7% | 66.2% |
| 70%–80% | 793 | 73.9% | 77.8% |
| 80%–100% | 571 | 86.5% | 89.8% |

| Stat | n | Brier (model) | Brier (base rate) | Mean predicted | Actual over rate |
|---|---|---|---|---|---|
| passing_yards | 750 | 0.1818 | 0.2495 | 52.0% | 52.1% |
| attempts | 786 | 0.1567 | 0.2500 | 47.5% | 50.4% |
| completions | 798 | 0.1632 | 0.2500 | 48.7% | 50.5% |
| rushing_yards | 1,686 | 0.2159 | 0.2389 | 39.4% | 39.4% |
| carries | 1,281 | 0.1865 | 0.2470 | 40.6% | 44.5% |
| receiving_yards | 3,471 | 0.2238 | 0.2406 | 41.1% | 40.3% |
| receptions | 3,573 | 0.2182 | 0.2468 | 42.8% | 44.4% |
| targets | 3,486 | 0.2147 | 0.2464 | 43.2% | 44.0% |

Sides the model liked at ≥58% against a line at the player's recent average: **2143–1018 (67.8%)** over 3,161 picks. That is a test against a *naive* line, not a sportsbook's — it shows the probabilities carry signal, not that the market is beatable.

## Anytime touchdown (non-QB)

| Model said | n | Predicted | Actual |
|---|---|---|---|
| 0%–10% | 33 | 8.1% | 9.1% |
| 10%–20% | 484 | 15.6% | 16.5% |
| 20%–30% | 451 | 24.3% | 25.3% |
| 30%–40% | 284 | 35.0% | 37.3% |
| 40%–50% | 124 | 44.0% | 45.2% |
| 50%–100% | 66 | 56.8% | 66.7% |

## Team defense (DST) — DraftKings points

272 team-games. DST scoring is mostly noise, so the bar is ranking defenses better than their own recent average does.

| | MAE | Rank corr |
|---|---|---|
| Model | 3.83 | 0.311 |
| Defense's recent average | 4.09 | 0.144 |
| Last 4 games | 4.31 | |
| League average for everyone | 4.09 | |

Each week's five highest-projected defenses averaged **8.2** DK points, the five lowest **3.3**, all defenses 5.9. The 80% band covered 81% of outcomes; bias +0.30.

| Component | Model MAE | Recent avg MAE |
|---|---|---|
| sacks | 1.323 | 1.365 |
| interceptions | 0.682 | 0.669 |
| fumble recoveries | 0.630 | 0.653 |
| tds | 0.132 | 0.120 |
| points allowed | 7.240 | 7.690 |
