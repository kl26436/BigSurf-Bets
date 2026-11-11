# Kickers (`model/kicker.py`)

Projected for showdown slates only (classic has no kicker). DraftKings: +1 per extra point, +3 / +4 / +5 per field
goal from 0–39 / 40–49 / 50+ yards.

One row per team per game. Features: the team's and opponent's implied totals, spread, total, home, dome, and the
team's recent kicker scoring (short and long average) and field-goal attempts. The upcoming week's kicker is whoever
kicked in the team's last game; a kicker ruled out is not projected.

## Holdout (measured 2026-11-11, nflverse through week 9)

| Trained on | Tested on | Team-games | Model MAE | Team's recent average | League average for everyone | Rank corr model / recent | 80% range covered |
|---|---|---|---|---|---|---|---|
| 2019–2025 | 2026 wk 1–9 | 272 | 3.70 | 3.77 | 3.70 | 0.04 / 0.09 | 77% |
| 2019–2024 | 2025 | 570 | 3.69 | 3.82 | 3.74 | 0.18 / 0.11 | 77% |

Read plainly: **kicker scoring is close to unpredictable.** The model is no better than giving every kicker the league
average in 2026 and slightly better in 2025. It is biased about half a point low (kickers have scored more in 2025–26
than the training years: 8.8 a game against 8.1). Its job is to put a sensible number and range on a kicker so the
showdown optimizer can use one as a cheap sixth player, not to find the good kicker.

In the slate simulation a kicker is drawn independently of his team (no role in `role_corr.json`).
