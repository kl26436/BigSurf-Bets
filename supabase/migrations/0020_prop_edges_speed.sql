-- Big Surf Bets — bsb.prop_edges in one pass
--
-- The view found each week's newest run with a subquery evaluated once per
-- row, which hid the row count from the planner (it expected ~166 rows of
-- 8,400). It then matched every book's line to Pinnacle's with a nested loop
-- (8,400 × 8,400). The app reads app_prop_edges 1,000 rows at a time, and
-- each page re-ran the whole view, so page 8 passed the 8-second statement
-- timeout and the Bets screen stayed on "Loading…" (Nov 12, two prop pulls in
-- one afternoon). Same rows and columns, now a hash join: ~1.2 s for the first
-- page before, ~80 ms for the last page after.

begin;

create or replace view bsb.prop_edges with (security_invoker = true) as
with last_run as (
    select season, week, max(run_id) as run_id from bsb.prop_prices group by season, week),
latest as (
    select p.* from bsb.prop_prices p
    join last_run r on r.season = p.season and r.week = p.week and r.run_id = p.run_id),
pin as (
    select run_id, player_id, stat, line, novig_over from latest
    where bookmaker = 'pinnacle' and novig_over is not null)
select l.season, l.week, l.game_id, l.player_id, pl.display_name as player_name, l.team, l.stat, l.line, l.bookmaker,
       l.over_decimal, l.under_decimal, l.hold, l.proj_mean, l.model_over,
       s.novig_over as fair_over,
       round(s.novig_over * l.over_decimal - 1, 4) as ev_over_fair,
       round((1 - s.novig_over) * l.under_decimal - 1, 4) as ev_under_fair,
       round(l.model_over * l.over_decimal - 1, 4) as ev_over_model,
       round((1 - l.model_over) * l.under_decimal - 1, 4) as ev_under_model,
       l.captured_at, l.run_id
from latest l
left join pin s on s.run_id = l.run_id and s.player_id = l.player_id and s.stat = l.stat and s.line = l.line
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = l.player_id;

commit;
