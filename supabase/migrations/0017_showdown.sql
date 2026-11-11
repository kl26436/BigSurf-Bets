-- 0017: single-game (captain) lineups and kickers.
--
-- Nothing new is stored: a showdown slate already imports as slate_type = 'showdown'
-- with a captain row and an ordinary row per player, and its lineups use the same
-- three lineup tables (six rows per lineup, slot 'CPT' or 'FLEX').
--
-- Kickers are projected from now on (position 'K'), for showdown. The fantasy league
-- does not use them, so they stay out of its "best available" list.

drop view if exists public.app_free_agents;
create view public.app_free_agents with (security_invoker = true) as
with snap as (
    select r.league_id, max(r.captured_at) as captured_at from bsb.fantasy_roster_snapshots r
    where r.league_id = (select league_id from bsb.fantasy_roster_snapshots where is_me order by captured_at desc limit 1)
    group by 1),
taken as (
    select distinct unnest(r.players) as sleeper_id
    from bsb.fantasy_roster_snapshots r join snap s on s.league_id = r.league_id and s.captured_at = r.captured_at)
select p.player_id, pl.display_name as name, p.position as pos, p.team, p.opponent, p.ppr_mean, p.ppr_p10, p.ppr_p90,
       p.dk_mean, p.injury_status, pl.headshot_url
from bsb.projections_latest p
join bsb.current_week() w on w.season = p.season and w.week = p.week
join bsb.players pl on pl.sport = 'nfl' and pl.player_id = p.player_id
where pl.sleeper_id is not null and exists (select 1 from snap)
  and p.position in ('QB', 'RB', 'WR', 'TE')
  and not exists (select 1 from taken t where t.sleeper_id = pl.sleeper_id);

revoke all on public.app_free_agents from public, anon, authenticated;
grant select on public.app_free_agents to authenticated;
