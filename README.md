# Big Surf Bets

NFL-first engine for DFS lineups (DraftKings), season-long fantasy (Sleeper),
pick'em (Underdog) and sportsbook edges. Architecture is sport-agnostic; NFL
is the first sport wired in.

**Phases 1–3 (done):** data lands in Supabase Postgres on a schedule; a player-week
projection model (stat means, DK/PPR points with an outcome distribution, prop
probabilities); a DraftKings classic lineup optimizer; market edges and a weekly scorecard.
**Phase 4 (in progress):** the web app in `app/` — see [docs/app-setup.md](docs/app-setup.md).
What a full review of phases 1–3 found and fixed: [docs/quality-review-2026-11-10.md](docs/quality-review-2026-11-10.md).

## Data sources

| Source | What | Cost | Key? |
|---|---|---|---|
| [nflverse](https://github.com/nflverse/nflverse-data) via `nflreadpy` | teams, players, schedules, weekly player stats (150 cols), official injury reports, closing lines | free | no |
| [Sleeper API](https://docs.sleeper.com) | near-real-time injury status, depth charts, **league rosters** | free | no |
| DraftKings | salaries via CSV export (reliable) or unofficial draftgroup JSON | free | no (your DK login) |
| [OddsPapi](https://oddspapi.io) | full boards incl. Pinnacle, props, historical | free 250 req/mo | yes |
| [OddsLink](https://oddslink.app) | game lines, all books | free 1,000 req/mo | yes |
| Underdog | pick'em lines | — | Phase 2 |

## Setup

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env                                 # fill in values
bsb db migrate                                       # create bsb.* schema in Supabase
bsb nfl backfill --seasons 2021-2026                 # ~5 min
bsb sleeper status
bsb db ping                                          # row counts
```

Sleeper league:

```bash
bsb sleeper leagues <your_username>                  # find the league_id
bsb sleeper league <league_id> --username <your_username>
```

DraftKings salaries: open a contest → "Export to CSV" → `bsb dk import-csv DKSalaries.csv`.

Odds (optional until you want sportsbook props):

```bash
python scripts/probe_odds.py                         # confirm book coverage on your keys
bsb odds oddspapi --days 7
bsb odds oddslink
```

## Projection model (`model/`)

```bash
pip install -e ".[dev,model]"
bsb model backtest --train 2019-2025 --test 2026 --weeks 1-9   # accuracy + calibration report
bsb model project                 # refresh data, retrain, project next week → bsb.projections
bsb model project --no-write      # same, local only (data/projections/*.csv), no database
bsb model price "ceedee lamb" receiving_yards 84.5             # fair odds for a prop
```

How it works:

- **One row per QB/RB/WR/TE per game**, built from nflverse box scores + snap counts
  (a player with snaps but no touches is a real zero, not a missing row).
- **Features use only earlier games** — player usage and efficiency (short/long EWMAs),
  snap share and depth rank, team volume, Vegas implied team total and spread,
  opponent defense both raw and opponent-adjusted, starting-QB quality, the player's own
  injury-report status, and usage vacated by teammates who are out. Upcoming games are
  appended as stat-less rows and run through the *same* code, so there is no separate
  inference path to leak or drift (`tests/test_model.py` enforces both).
- **One LightGBM model per stat** (Poisson for counts, squared error for yards). DK and
  PPR points are derived from those stats with the site scoring rules, so points and
  props never disagree.
- **Distributions** are fitted on leave-one-season-out predictions: negative binomial
  for counts, empirical for yards and fantasy points. That is where `dk_p10…dk_p90` and
  `P(over line)` come from.
- **Retrains on every run** (~4 min): Tuesday's projections have already seen Monday night.
- Players Sleeper lists as Out/IR/Doubtful (latest `player_status_snapshots`) are dropped
  and their usage flows to teammates.

Latest holdout (trained 2019–2025, scored on 2026 weeks 1–9):
[docs/model/backtest_2026_w01-09.md](docs/model/backtest_2026_w01-09.md).

**Team defense (DST)** has its own model (`model/dst.py`): sacks, interceptions, fumble
recoveries, return TDs and the points-allowed tier, driven mostly by the opponent (Vegas
implied total, spread, the opposing QB's sack/INT rates). Rows land in `bsb.projections`
with `position = 'DST'` and `player_id = 'DST_<team>'`.

**DraftKings slates:** upload a salary export to `slates/` on GitHub and the `DK slate import`
workflow loads it, then projections re-run. Players DK tags Out / IR / Doubtful on a fresh
export are treated as inactive (DK often flags them days before the injury report).

Known gaps: no kickers; rookies with no NFL game are not projected; weather is
not a feature; red-zone/route data (needs play-by-play) not used; the benchmark against
real sportsbook prop lines waits on `odds_snapshots` history.

## Lineup optimizer (`optimizer/`)

```bash
bsb lineups build --mode gpp --n 20              # tournament set from the newest upcoming slate in Supabase
bsb lineups build --mode cash --n 3 --max-exposure 0.67
bsb lineups build --lock "josh allen" --exclude "worthy,44851168"
bsb lineups build --csv slates/2026-w10-main.csv --projections data/projections/projections_2026_w10.parquet  # local, no DB
```

- **Solver** (`classic.py`): exact mixed-integer optimisation (HiGHS via scipy) of DK classic —
  $50k cap, QB / 2 RB / 3 WR / TE / FLEX / DST, players from ≥ 2 games — plus optional strategy
  rules: QB stack, bring-back, no offense against your own DST, max per team, lock / exclude.
- **Simulation** (`sim.py`, `corr.py`): 10,000 correlated versions of the slate. Each player is drawn
  from his projected distribution; draws are tied together by role correlations estimated from
  2021–2025 (QB↔WR1 +0.34, QB↔opposing DST −0.30, …). Every lineup gets a score *distribution*.
  Checked on 2026 weeks 1–9: the simulated 80% range covered 79–80% of actual lineup totals; with
  correlations switched off, stacked lineups' ranges were too narrow (76%).
- **Portfolio** (`portfolio.py`): N lineups with an exposure cap (default: no player in more than
  50%) and a minimum number of different players between any two (default 3). `cash` maximises
  expected score; `gpp` stacks the QB with a pass catcher, optimises against simulated outcomes and
  adds each lineup for what it contributes to the set's best score.
- Output: a DraftKings bulk-upload CSV + a readable detail CSV in `data/lineups/`, and
  `bsb.lineup_sets` / `lineups` / `lineup_players` in Supabase. The `Lineups` workflow rebuilds both
  sets after every projections run.

Not modelled yet: field ownership (so no leverage), showdown slates, late swap, and — because there
is no archive of past DK salaries — no historical ROI backtest of the lineups themselves.

## Markets and edges (`markets/`)

```bash
bsb edges show --min-ev 0.02     # arbitrage + +EV on game lines, props vs Pinnacle and vs the model
bsb edges lines                  # re-analyse the newest game-line snapshot
bsb model scorecard              # grade the last finished week
```

- **Props** (`props.py`): each projections run prices every current prop for the week into
  `bsb.prop_prices` — provider market → our stat and line (`"40+"` → over 39.5), `"Last, First"` →
  our `player_id`, over/under paired per book with the vig stripped, plus the model's P(over).
  `bsb.prop_edges` adds Pinnacle's no-vig probability at the same line and the EV of each side at
  each book under Pinnacle's number and under the model's. Only markets named "(incl. overtime)"
  are used; the same names without it are mislabelled in the feed.
- **Game lines** (`lines.py`): `bsb.line_quotes` holds every book's moneyline / spread / total quote
  with Pinnacle fair value, EV, best-price flag and the arbitrage return of the market. A book's
  quote is ignored unless its own two sides form a sane market (0–12% vig) — the feed carries rows
  like −175 / +14400 that would otherwise look like arbitrage.
- **Scorecard** (`model/scorecard.py`): every Tuesday the last finished week is graded into
  `bsb.scorecards` — projections believed at kickoff vs actual (and vs DraftKings' own average
  points), each saved lineup's real score vs its simulated range, and the model's prop
  probabilities vs Pinnacle's with the P&L of the edges it flagged. `bsb.player_results` keeps the
  actual DK/PPR points per player and DST. The lineups it reports are the ones on the app's Lineups
  screen at the time (the newest automatic set of each kind, and every set the user built that is not
  archived) plus anything marked as entered; superseded automatic sets are left out.
- Odds snapshots: Thu 18:00, Sat 22:00, Sun 10:00, Mon 18:00 ET (props are only posted near game
  day). ≈ 125 of OddsPapi's 250 monthly requests.

Model-based prop edges are unproven until the scorecard has several weeks of history; edges
against Pinnacle's fair value do not depend on the model.

## Secrets

GitHub → Settings → Secrets and variables → Actions:

| Secret | Notes |
|---|---|
| `SUPABASE_DB_URL` | **Session pooler** URI (port 5432). Direct connection is IPv6-only and fails on Actions runners. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | for the PWA (Phase 3) |
| `ODDSPAPI_API_KEY`, `ODDSLINK_API_KEY` | optional |
| `ANTHROPIC_API_KEY` | agents (Phase 5) |

Repository **variables** (not secrets): `SLEEPER_LEAGUE_ID`, `SLEEPER_USERNAME`.

## Schedule

The timetable follows when information arrives (US Eastern): stats Tue 06:10 and Sat 08:10; player statuses Wed and
Fri 17:10 (final injury reports), Thu and Mon 18:55 (inactives), and every 30 minutes Sunday 10:10–15:40; odds Thu 18:55,
Sat 22:05, Sun 10:05, Mon 18:55. Every ingest triggers `Projections`, which re-runs only if its inputs changed, then `Lineups`.

Two schedulers, same plan: the database (pg_cron → workflow_dispatch, `0007_scheduler.sql`, exact to the minute, needs the
GitHub token described in docs/app-setup.md) and the cron lines in `weekly-ingest.yml` (fallback, off the hour). When both
fire, the later one skips work already done. `Feed health` fails — and emails — when a feed goes quiet.

Trigger any job manually from the Actions tab (`Weekly ingest` → Run workflow → `jobs`: `stats`, `status`, `odds`, `league` or `all`).

## Schema (`bsb.*`)

- `teams`, `players`, `games` — reference + schedule (games carries nflverse closing lines for backtests)
- `player_week_stats` — one row per player-week; DK + PPR points precomputed; all 150 nflverse columns in `raw`
- `injury_reports` (official weekly) and `player_status_snapshots` (Sleeper, append-only)
- `odds_snapshots` (append-only, every book/market/outcome) + `odds_latest` view
- `dfs_slates`, `dfs_salaries` — DraftKings contests
- `fantasy_leagues`, `fantasy_roster_snapshots` — Sleeper leagues
- `model_runs`, `projections` (append-only) + `projections_latest` view — Phase 2 output;
  stat columns share names with `player_week_stats` so projected-vs-actual is a plain join
- `ingest_runs` — every job run, with row counts and errors
- `app_users`, `app_jobs`, `projection_overrides`, `user_settings`, `dispatches` — the app's side (Phase 4)
- `lineup_sets` carry what the app adds: `source` (auto / user / manual), `label`, `entered`, `archived_at`. A set
  marked as entered cannot be deleted or changed (`bsb_delete_set`, `bsb_delete_lineup` refuse); archive it instead
- `public.app_*` views and `public.bsb_*` functions — the only things the app can reach; `bsb` itself is closed
  to the API roles (row-level security on every table)

## Layout

```
ingest/          Python package (bsb CLI)
model/           projection model: features, training, distributions, backtest, projection
optimizer/       lineup engine: slate pool, correlated simulation, solver, portfolios
slates/          DraftKings salary exports (uploading one triggers import → projections → lineups)
docs/model/      backtest reports
supabase/        SQL migrations
scripts/         one-off probes
.github/         Actions: ci, weekly-ingest, projections, lineups, app-jobs, app (build + deploy), health, backfill
app/             the web app (React + Vite PWA) — docs/app-setup.md
markets/         props and game lines: fair value, edges, arbitrage
tests/           unit tests + database tests (tests/test_db_access.py needs TEST_DATABASE_URL)
```

## Roadmap

1. Data ✓
2. Projections ✓: player-week + DST models, DK/PPR outputs, prop probabilities
3. Engines: DK classic optimizer ✓, market edges ✓, scorecard ✓; showdown + kickers, Underdog lines still open
4. **PWA** ← you are here: app built (lineups, players, bets, results, league); hosting at bigsurf.bet and web push still to do
5. Agents (Claude) to argue through picks
6. More sports; Kalshi (the one venue with an official, sanctioned API)
