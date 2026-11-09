# Big Surf Bets

NFL-first engine for DFS lineups (DraftKings), season-long fantasy (Sleeper),
pick'em (Underdog) and sportsbook edges. Architecture is sport-agnostic; NFL
is the first sport wired in.

**Phase 1 (this repo today):** data lands in Supabase Postgres on a schedule.
Modeling, lineup optimization and the PWA come after the tables fill.

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

Trigger any job manually from the Actions tab (`Weekly ingest` → Run workflow).

## Schema (`bsb.*`)

- `teams`, `players`, `games` — reference + schedule (games carries nflverse closing lines for backtests)
- `player_week_stats` — one row per player-week; DK + PPR points precomputed; all 150 nflverse columns in `raw`
- `injury_reports` (official weekly) and `player_status_snapshots` (Sleeper, append-only)
- `odds_snapshots` (append-only, every book/market/outcome) + `odds_latest` view
- `dfs_slates`, `dfs_salaries` — DraftKings contests
- `fantasy_leagues`, `fantasy_roster_snapshots` — Sleeper leagues
- `ingest_runs` — every job run, with row counts and errors

## Layout

```
ingest/          Python package (bsb CLI)
supabase/        SQL migrations
scripts/         one-off probes
.github/         Actions: ci, backfill, weekly-ingest
tests/
```

## Roadmap

1. **Data** ← you are here
2. Projections: player-week model (opponent-adjusted usage × efficiency), DK/PPR/Underdog outputs
3. Engines: DK classic + showdown optimizer with exposure limits; Sleeper start/sit + waivers; Underdog vs Pinnacle edge finder
4. PWA (Firebase Hosting, Supabase reads, web push) at bigsurf.bet
5. Agents (Claude) to argue through picks
6. More sports; Kalshi (the one venue with an official, sanctioned API)
