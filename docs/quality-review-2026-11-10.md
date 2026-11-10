# Quality review — phases 1–3 (2026-11-10)

Scope: every module in `ingest/`, `model/`, `optimizer/`, `markets/`, the workflows, the migrations, and the data
in Supabase as of Tuesday of week 10. Method: read the code, query the data it produced, and run the model locally.
Each finding says how it was confirmed. Fixes are in the same commit as this file unless marked **open**.

## Would have produced wrong numbers

| # | Finding | How it was confirmed | Status |
|---|---|---|---|
| 1 | **The week being projected jumped ahead after Thursday night.** `next_week` returned the first week with *no* game played, so from Friday on it would have projected week 11. The Friday, Saturday and Sunday-morning runs — the ones that carry final injury news and inactives — would never have touched the Sunday slate, and lineups would have stayed on Tuesday's numbers. | Read `model/data.py`; reproduced with a five-game schedule in `tests/test_pipeline_fixes.py`. It had not bitten yet only because the model first ran on a Tuesday. | Fixed: the week stays in play until its last game; teams that have already played are not re-projected. |
| 2 | **Every plus-money price from OddsLink was stored as a 100-to-1 shot.** The feed quotes American odds; only negatives were converted, so +145 was saved as decimal 145.0. 480 of 2,610 rows, including every underdog moneyline (405 of 870). The line tool then discarded those markets as "garbage quotes", so its "no arbitrage, nothing beats Pinnacle by 1%" came from the few markets where both sides were minus money. | `odds_snapshots`: OddsLink has zero prices between 2.0 and 100 and 480 at 100 or more; OddsPapi has none of the latter on game lines. | Fixed in the parser; stored rows repaired exactly (`0008`), analyses rebuilt from the next snapshot. |
| 3 | **Four in five Sleeper injury statuses were thrown away.** Players were matched on the `gsis_id` Sleeper supplies, which it has for 177 of 872 skill players; 33 of 196 injured players were matched. An unmatched Out player stayed in the projections unless DraftKings happened to tag him. | Counted mapped rows in the newest `player_status_snapshots`. | Fixed: matching falls back to name + team, then name + position; earlier snapshots are back-filled. The run log now records the matched share. |
| 4 | **Last week's "Out" kept players out of this week.** Sleeper keeps a game designation until the next report replaces it. On Tuesday, Mike Evans, Deebo Samuel, David Montgomery and Deshaun Watson were Out for week 9, Questionable on DraftKings for week 10, and missing from the week-10 projections. | Joined slate, Sleeper snapshot and week-9 injury report for unprojected players above $4,500. | Fixed: an Out/Doubtful seen more than 28 hours before kickoff is ignored when DraftKings lists the player as available; long-term statuses (IR, PUP, suspended) always hold. |
| 5 | **Players returning after six or more weeks were never projected**, however healthy (candidates had to have played in the last five weeks). | Read `_upcoming_rows`. | Fixed for players DraftKings lists as available. **Open** for teams with no DraftKings slate loaded. |
| 6 | The schedule's "what to run" step read the clock, not the cron line that fired. A Thursday 18:00 ET odds run starting after midnight UTC would have run a stats refresh instead and skipped the odds. | Read the workflow. | Fixed: decided from `github.event.schedule`. |

## Would have stopped the pipeline or exposed data

| # | Finding | Status |
|---|---|---|
| 7 | **No scheduled run had fired**; all crons sat at minute 0, where GitHub drops them most. | Fixed three ways: crons moved off the hour; a database timetable (pg_cron → workflow_dispatch) that fires on the minute once the GitHub token is in place; a daily `Feed health` workflow that fails, and so emails, when a feed goes quiet. |
| 8 | **Every table was readable by anyone holding the public key**: `anon` had SELECT on all 22 tables, no row-level security, and `0001` re-granted it on every deploy. That includes the Sleeper league rosters. | Fixed (`0006`): `anon` has nothing; RLS on every table; only signed-in accounts in `bsb.app_users` read, through `app_*` views; writes only through checked functions. Tested as anon, as a signed-in stranger and as a member (`tests/test_db_access.py`), in CI against a real Postgres. |
| 9 | Migrations were re-run in full on every deploy. One non-idempotent statement would have broken every workflow; and see #8. | Fixed: applied once, recorded in `bsb.schema_migrations`. |
| 10 | The Sunday 11:30 ET status snapshot ran at the exact minute inactives are published, there was none for the 4 pm games, and none from Tuesday to Sunday — Friday's projections had no Sleeper data inside the 48-hour window. The "Fri 06:00 final injury reports" run was ten hours before those reports exist. | Fixed: timetable follows when information arrives (see `weekly-ingest.yml`). Projections re-run only when their inputs change (`inputs_hash`), so frequent snapshots cost a minute of free CI each. |
| 11 | The Sleeper league tables were created by the ingest at run time, not by a migration; a fresh database could not be built from the repo. | Fixed (`0006`). |
| 12 | A projections run could cancel one that was minutes from finishing (`cancel-in-progress`). | Fixed: runs queue instead. |

## Smaller defects

- DraftKings names that nflverse still lists on an old team stayed unmapped (traded players). Fixed with a name + position second pass.
- `bsb dk fetch` (the unofficial draft-group endpoint) cannot work as written: it stores numeric roster-slot ids where the importer expects "RB/FLEX", writes `playerId` where the upload file needs the draftable id, and its date format does not match the parser. **Open** — nothing calls it; the supported path is the salary export.
- Lineup sets had no notion of who asked for them, so an automatic rebuild could not be told from a set already entered. Fixed: `source`, `entered`, `label`.
- An ingest that returns zero rows is logged as a success. The health view now requires rows to count a run as fresh.

## Checked and found sound

- **No look-ahead in the features.** Every rolling window is shifted; upcoming rows go through the same code as history; the leak tests cover player and DST frames.
- **Starting quarterbacks for the coming week are known to the model**: nflverse fills the expected starters into the schedule (checked on week 10). They can lag a late change — use an override.
- DraftKings scoring (bonuses, turnovers, DST tiers) matches the published rules. The solver enforces budget, positions, two-game and stacking rules exactly; the upload file is in DraftKings' slot order with draftable ids.
- Projections, lineup sets and prop prices are written in one transaction each: a cancelled run leaves nothing half-written.
- 36 existing tests pass in a clean install; 15 added.

## Limits that are not defects (unchanged, still true)

- Beating a naive average by 5% is not beating the market. No prop history exists yet to test that; the first scorecard is week 10 (graded Nov 17).
- No lineup ROI backtest: there is no archive of past salaries, ownership or contest results.
- No ownership estimates, no late swap, Questionable players are treated as playing.
- No kickers, so no showdown (captain) lineups and no kicker numbers for the Sleeper league. **Open.**
- Rookies with no NFL game are not projected.

## Needs a decision

- **Database size: 388 MB of the free plan's 500 MB.** 272 MB is `player_week_stats`, almost all of it the `raw` column holding all 150 nflverse columns per row, which nothing reads (the model loads nflverse directly). At the current rate the limit is reached around the playoffs, and Supabase then makes the database read-only. Dropping that column (and `players.raw`, `injury_reports.raw`) frees about 330 MB and can be undone by re-running the backfill. Not done without an explicit yes because it deletes stored data.
