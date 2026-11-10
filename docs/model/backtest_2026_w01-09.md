# Backtest — 2026 weeks 1–9

Trained on 2019–2025 (49,169 player-games, 218 features); scored on 3,476 player-games the model never saw.

## DraftKings points (fantasy-relevant players)

| Pos | n | Model MAE | Best naive MAE | Improvement | Bias | Rank corr (model / naive) | 80% band covers | 50% band covers |
|---|---|---|---|---|---|---|---|---|
| QB | 304 | 6.31 | 6.90 (recent avg) | +8.6% | +0.38 | 0.496 / 0.444 | 80% | 50% |
| RB | 442 | 5.74 | 6.08 (recent avg) | +5.7% | -0.19 | 0.576 / 0.513 | 83% | 49% |
| WR | 690 | 5.72 | 5.96 (recent avg) | +4.1% | +0.01 | 0.542 / 0.472 | 85% | 53% |
| TE | 321 | 5.38 | 5.54 (recent avg) | +2.9% | +0.07 | 0.326 / 0.298 | 78% | 46% |
| ALL | 1,757 | 5.76 | 6.08 (recent avg) | +5.2% | +0.04 | 0.584 / 0.510 | 82% | 50% |

## PPR points (fantasy-relevant players)

| Pos | n | Model MAE | Best naive MAE | Improvement | Rank corr (model / naive) |
|---|---|---|---|---|---|
| QB | 303 | 6.08 | 6.63 | +8.2% | 0.466 / 0.419 |
| RB | 437 | 5.47 | 5.77 | +5.2% | 0.566 / 0.509 |
| WR | 686 | 5.38 | 5.62 | +4.3% | 0.536 / 0.463 |
| TE | 320 | 5.28 | 5.42 | +2.5% | 0.327 / 0.300 |
| ALL | 1,746 | 5.50 | 5.79 | +5.0% | 0.566 / 0.494 |

## Stat projections — mean absolute error

| Stat | n | Model | Recent avg (EWMA) | Last 4 | Season avg | Model vs best naive |
|---|---|---|---|---|---|---|
| attempts | 316 | 6.488 | 8.534 | 9.002 | 8.795 | -24.0% |
| completions | 316 | 4.491 | 5.712 | 6.022 | 5.800 | -21.4% |
| passing_yards | 316 | 57.529 | 67.921 | 71.948 | 72.522 | -15.3% |
| passing_tds | 316 | 0.810 | 0.851 | 0.897 | 0.934 | -4.7% |
| interceptions | 316 | 0.606 | 0.647 | 0.665 | 0.627 | -3.5% |
| carries | 3,382 | 0.990 | 1.073 | 1.083 | 1.071 | -7.5% |
| rushing_yards | 3,382 | 5.646 | 5.944 | 6.118 | 6.003 | -5.0% |
| rushing_tds | 3,382 | 0.101 | 0.101 | 0.099 | 0.101 | +2.4% |
| targets | 3,066 | 1.449 | 1.517 | 1.566 | 1.557 | -4.5% |
| receptions | 3,066 | 1.123 | 1.148 | 1.191 | 1.196 | -2.2% |
| receiving_yards | 3,066 | 14.465 | 14.778 | 15.407 | 15.492 | -2.1% |
| receiving_tds | 3,066 | 0.203 | 0.207 | 0.203 | 0.207 | -0.1% |

## Over/under probabilities — reliability

Synthetic lines at 75% / 100% / 125% of each listed player's recent average. A calibrated model's *actual* column matches *predicted*.

| Model said P(over) | n | Predicted | Actual |
|---|---|---|---|
| 0%–20% | 1,651 | 14.1% | 14.3% |
| 20%–30% | 2,637 | 25.3% | 25.3% |
| 30%–40% | 3,261 | 35.0% | 35.2% |
| 40%–50% | 2,954 | 44.9% | 45.4% |
| 50%–60% | 2,303 | 54.9% | 55.7% |
| 60%–70% | 1,732 | 64.7% | 66.6% |
| 70%–80% | 822 | 73.9% | 76.2% |
| 80%–100% | 588 | 86.2% | 89.1% |

| Stat | n | Brier (model) | Brier (base rate) | Mean predicted | Actual over rate |
|---|---|---|---|---|---|
| passing_yards | 756 | 0.1855 | 0.2497 | 52.3% | 51.9% |
| attempts | 792 | 0.1563 | 0.2500 | 47.7% | 50.4% |
| completions | 804 | 0.1655 | 0.2500 | 48.4% | 50.2% |
| rushing_yards | 1,698 | 0.2144 | 0.2386 | 39.4% | 39.3% |
| carries | 1,293 | 0.1879 | 0.2469 | 40.7% | 44.4% |
| receiving_yards | 3,495 | 0.2231 | 0.2405 | 41.2% | 40.3% |
| receptions | 3,600 | 0.2183 | 0.2467 | 42.9% | 44.2% |
| targets | 3,510 | 0.2150 | 0.2464 | 43.5% | 44.0% |

Sides the model liked at ≥58% against a line at the player's recent average: **2127–1031 (67.4%)** over 3,158 picks. That is a test against a *naive* line, not a sportsbook's — it shows the probabilities carry signal, not that the market is beatable.

## Anytime touchdown (non-QB)

| Model said | n | Predicted | Actual |
|---|---|---|---|
| 0%–10% | 33 | 8.6% | 9.1% |
| 10%–20% | 449 | 15.6% | 15.6% |
| 20%–30% | 487 | 24.4% | 24.8% |
| 30%–40% | 301 | 34.8% | 36.5% |
| 40%–50% | 120 | 44.2% | 44.2% |
| 50%–100% | 63 | 56.2% | 74.6% |

## Team defense (DST) — DraftKings points

272 team-games. DST scoring is mostly noise, so the bar is ranking defenses better than their own recent average does.

| | MAE | Rank corr |
|---|---|---|
| Model | 3.84 | 0.295 |
| Defense's recent average | 4.09 | 0.144 |
| Last 4 games | 4.31 | |
| League average for everyone | 4.08 | |

Each week's five highest-projected defenses averaged **7.6** DK points, the five lowest **3.4**, all defenses 5.9. The 80% band covered 84% of outcomes; bias +0.32.

| Component | Model MAE | Recent avg MAE |
|---|---|---|
| sacks | 1.325 | 1.365 |
| interceptions | 0.681 | 0.669 |
| fumble recoveries | 0.634 | 0.653 |
| tds | 0.130 | 0.120 |
| points allowed | 7.227 | 7.690 |
