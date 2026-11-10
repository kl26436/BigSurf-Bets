# Model experiments log

What was tried, what it did, and what was kept. Every test uses the same two yardsticks so
results are comparable:

- **Out-of-fold (OOF)** — leave-one-season-out predictions on 2021–2025 (≈36,000 player-games).
  The larger and more trustworthy sample.
- **Holdout** — train through 2025, score 2026 weeks 1–9 (≈3,400 player-games).

Counts are scored by Poisson deviance, yards by RMSE, DK points by mean absolute error on
fantasy-relevant players (recent DK average ≥ 5). Lower is better. A change is kept only if it
helps consistently; anything inside ±0.5% that changes sign between stats is noise.

## 2026-11-10 — model upgrades round 1

| Change | OOF effect | Holdout effect | Decision |
|---|---|---|---|
| Red-zone / goal-line usage from play-by-play (carries inside 20/10/5, red-zone and end-zone targets, deep targets, shares of team totals) plus nflverse `ff_opportunity` expected yards / catches / TDs, 51 new features | −0.5% to +0.4% across stats, no direction; DK MAE +0.10%; anytime-TD log loss 0.5505 → 0.5508 | −0.5% to +1.6%; DK MAE +0.34% | **Dropped** |
| Weather (wind, temperature; indoors = calm) | −0.5% to +0.3%, no direction; DK MAE −0.05% | DK MAE +0.21% | **Dropped** (also: nflverse weather is missing for a third of 2026 and upcoming games would need a forecast feed) |
| Train from 2019 instead of 2021 (+2 seasons, +40% rows) | better on **all 10 stats**, −0.25% to −1.1%; DK MAE −0.13%; rank corr 0.595 → 0.599 | mixed, DK MAE +0.06% | **Kept** (small, but the only change with a consistent direction; costs ~1.5 min per run) |
| 600 trees at learning rate 0.02 (was 350 at 0.03) | within ±0.6%, DK MAE +0.03% | DK MAE ±0.00% | Dropped |
| 31 leaves, min 100 rows per leaf (was 15 / 60) | mixed, attempts +1.3%; DK MAE −0.09% | DK MAE +0.13% | Dropped |
| 7 leaves, 700 trees, 35% of features per tree | within ±0.4%; DK MAE +0.05% | DK MAE −0.09% | Dropped |

### What this says

The surprise is the first row. The expectation was that knowing *where* touches happen would fix
touchdown projections. It does not, and the reason is visible in the model: once it knows a
player's volume, his team's Vegas implied total and the matchup, red-zone role adds almost
nothing, because a player's red-zone sample over a few games is tiny and mostly luck. The
touchdown probabilities were already well calibrated (when the model says 35%, it happens 37%);
they are simply not very *sharp*, and neither is anyone else's — weekly touchdowns are close to
irreducible noise.

Together with the flat tuning results this means the model is near the ceiling of what
box-score, play-by-play and Vegas game lines can give. More features of the same kind are
unlikely to move it. What could:

1. **Market information as an input** — player prop lines embed injury news, role changes and
   coaching intent that no stat feed has. Needs the prop history that started accumulating in
   `bsb.prop_prices` in week 10.
2. **Availability and role news** — who is actually starting, snap-count limits on players
   returning from injury. Mostly a data-timing problem (Sunday inactives), partly handled.
3. **Route participation** — nflverse participation data stops at 2025; a paid charting feed
   would be needed for the current season.

Not re-tested here: rookies with no NFL games (matters in weeks 1–3; an offseason job).
