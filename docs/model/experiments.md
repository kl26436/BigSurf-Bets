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

## Week 10 2026 review: vacated carries, and choosing lineups against the field (Nov 17 2026)

One tournament cash from 20 entries. What the data showed, and what was changed.

### Vacated carries (`model/volume.py`)

Kansas City's starter (projected 19.5 carries) was ruled out on Saturday. The model moved his
backup from 4 carries to 12 and the rest left the team's total. He carried 22 times for 38.1 DK
points at $4,700, in 56% of the $500K contest's lineups and none of ours.

Out of sample (trained 2019–2024, tested on 2025 and 2026 weeks 1–10; 774 team-weeks):

| Projected RB carries ÷ team's recent RB carries | team-weeks | model gave | team actually ran |
|---|---|---|---|
| under 0.75 | 24 | 0.57–0.69 of recent | 0.87–0.97 of recent |
| 0.75–0.90 | 143 | 0.84 | 0.94 |
| 0.90–1.10 | 419 | 0.99 | 0.99 |

Rule: under 0.80 of recent, lift the team's backs to 0.90 of recent, the gap shared in proportion
to projected carries squared, no back more than doubled. On the 122 affected player-games:

| | before | after |
|---|---|---|
| DK bias | −0.98 | +0.02 |
| Carries MAE | 3.31 | 3.00 |
| DK MAE | 4.28 | 4.30 |
| Actual above the 90th percentile | 10.7% | 7.4% |

It removes the bias and gives these backs the ceiling they have. It does not reduce their error:
which backup takes the work is still a guess. Replayed on week 10 with the same inputs the
pipeline had, the backup goes from 11.9 to 15.6 DK points (90th percentile 22 → 29).

Not done: the same question for targets (a missing receiver's targets spread across positions;
no evidence yet that the model mishandles it).

### Lineups valued against the field (`optimizer/ownership.py`, `optimizer/portfolio.py`)

Tournament sets were chosen for what each lineup added to the set's best simulated score. That
picks lineups that win in unusual weeks, at a cost of about two projected points per lineup.
They are now chosen by expected winnings against a sampled field of opponents.

- Ownership: within a position, share ∝ exp(0.75·z(points per $1,000) + 0.5·z(points)). Fitted to
  the one contest on file (198,176 entries). Correlation with real ownership on that same slate:
  0.64 (RB) to 0.81 (TE). In-sample, one slate. It refits from every results file added
  (`ownership.fit_from_db`, used from two slates up).
- Field: 5,000 lineups drawn by ownership, QB usually with a pass catcher, $48,500–$50,000
  spent. Drawn from the *true* week-10 ownership, the sampled field's real scores came in 3–4%
  under the contest's at every percentile, so the lines are raised 3% (`FIELD_EDGE`).
- Payouts: top 22% 1.67×, 10% 2×, 2.5% 3.3×, 0.5% 6.7×, 0.1% 25×. Nothing above the top 0.1%
  is valued (a sampled field cannot see it), so the "expected return" printed with a set is a
  lower bound on a relative scale, not the contest's true value.

What it showed: one projected point is worth about forty points of summed ownership at these
payout tiers. Being right about a player matters far more than being different.

Week 10 replayed (20 lineups, 50% exposure cap, real results, real contest percentiles):

| Builder | pool | avg score | at or above the top-25% score (174.3) | top-10% (193.7) |
|---|---|---|---|---|
| previous | as it was | 129–139 (3 seeds) | 1–2 | 1 |
| field | as it was | 137.5 | 3 | 2 |
| previous | backup lifted | 139–142 | 2 | 1–2 |
| field | backup lifted | 151.3 | 5 | 2 |
| entered on the day | built 10:46 | 127.2 | 1 | 1 |

One slate. It cannot show the new builder is better, only that it behaves as intended on the
week that prompted it. The field builder also concentrates more (30 players used against 43, nine
at the exposure cap), so a bad week for the core is a bad week for most of the set; the
exposure cap is the control for that.

Self-assessment to distrust: the simulation says 35% of these entries cash. The simulation
assumes our projections are right. Grade `summary.field.cash_rate` against real results each week
before believing it.
