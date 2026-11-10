# Big Surf Bets

NFL-first engine for DFS lineups (DraftKings), season-long fantasy (Sleeper),
pick'em (Underdog) and sportsbook edges. Architecture is sport-agnostic; NFL
is the first sport wired in.

**Phase 1 (done):** data lands in Supabase Postgres on a schedule.
**Phase 2 (in progress):** player-week projection model — stat means, DK/PPR
points with an outcome distribution, and over/under probabilities for props.
Lineup optimization and the PWA come next.

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
bsb model backtest --train 2021-2025 --test 2026 --weeks 1-9   # accuracy + calibration report
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
- **Retrains on every run** (~3 min): Tuesday's projections have already seen Monday night.
- Players Sleeper lists as Out/IR/Doubtful (latest `player_status_snapshots`) are dropped
  and their usage flows to teammates.

Latest holdout (trained 2021–2025, scored on 2026 weeks 1–9):
[docs/model/backtest_2026_w01-09.md](docs/model/backtest_2026_w01-09.md).

Known gaps: no kickers/DST yet; rookies with no NFL game are not projected; weather is
not a feature; red-zone/route data (needs play-by-play) not used; the benchmark against
real sportsbook prop lines waits on `odds_snapshots` history.

## Secrets

GitHub → Settings → Secrets and variables → Actions:

| Secret | Notes |
|---|---|
| `SUPABASE_DB_URL` | **Session pooler** URI (port 5432). Direct connection is IPv6-only and fails on Actions runners. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | for the PWA (Phase 3) |
| `ODDSPAPI_API_KEY`, `ODDSLINK_API_KEY` | optional |
| `ANTHROPIC_API_KEY` | agents (Phase 5) |

Repository **variables** (not secrets): `SLEEPER_LEAGUE_ID`, `SLEEPER_USERNAME`.

## Schedule (GitHub Actions, UTC)

| When (ET) | Job |
|---|---|
| Tue 06:00 | stats + injuries refresh (post-MNF), league snapshot |
| Fri 06:00 | final injury reports, TNF stats, league snapshot |
| Sat 22:00 | odds snapshot |
| Sun 10:00 | odds snapshot + Sleeper status |
| Sun 11:30 | Sleeper status (inactives for 1pm games) |
| after each ingest | `Projections` workflow: retrain + project the upcoming week |

Trigger any job manually from the Actions tab (`Weekly ingest` → Run workflow).

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

## Layout

```
ingest/          Python package (bsb CLI)
model/           projection model: features, training, distributions, backtest, projection
docs/model/      backtest reports
supabase/        SQL migrations
scripts/         one-off probes
.github/         Actions: ci, backfill, weekly-ingest
tests/
```

## Roadmap

1. Data ✓
2. **Projections** ← you are here: player-week model, DK/PPR outputs, prop probabilities
3. Engines: DK classic + showdown optimizer with exposure limits; Sleeper start/sit + waivers; Underdog vs Pinnacle edge finder
4. PWA (Firebase Hosting, Supabase reads, web push) at bigsurf.bet
5. Agents (Claude) to argue through picks
6. More sports; Kalshi (the one venue with an official, sanctioned API)
