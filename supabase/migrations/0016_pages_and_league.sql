-- 0016: what the app needs for Price a line, player-level results, "your changes",
-- and the chop league's start/sit, what-is-coming and price-check views.
--
-- model_dists     the outcome shapes the model fitted for each stat, one row per stat,
--                 replaced on every projection run. Small (a few kB each): the app prices
--                 any number for any player from these without asking the server.
-- player_results  gains what we expected at kickoff, so a result can be shown beside it.
-- waiver_runs     gains the best lineup, what rivals' players may come free, the
--                 bid-now-or-wait read, and how last week's prices compared with the bids
--                 that actually won.

create table if not exists bsb.model_dists (
    stat       text primary key,
    kind       text not null check (kind in ('nb', 'emp')),
    params     jsonb not null,
    run_id     bigint,
    updated_at timestamptz not null default now()
);
alter table bsb.model_dists enable row level security;
drop policy if exists members_read on bsb.model_dists;
create policy members_read on bsb.model_dists for select to authenticated using ((select bsb.is_member()));
grant select on bsb.model_dists to authenticated;
grant all on bsb.model_dists to service_role;

alter table bsb.player_results add column if not exists proj_dk  numeric(6,2);
alter table bsb.player_results add column if not exists proj_p10 numeric(6,2);
alter table bsb.player_results add column if not exists proj_p90 numeric(6,2);

alter table bsb.waiver_runs add column if not exists lineup jsonb;   -- [{sleeper_id, name, pos, mean, start}]
alter table bsb.waiver_runs add column if not exists coming jsonb;   -- [{owner, chop_1, chop_3, players:[{name,pos,level,gain}]}]
alter table bsb.waiver_runs add column if not exists advice jsonb;   -- {verdict, best_now, best_later, …}
alter table bsb.waiver_runs add column if not exists grade  jsonb;   -- {week, rows:[{name, won_by, price, bid_50, bid_80, bid_95}], …}

drop view if exists public.app_model_dists, public.app_player_results, public.app_prop_results;

create view public.app_model_dists with (security_invoker = true) as
select d.stat, d.kind, d.params, d.run_id, d.updated_at from bsb.model_dists d;

create view public.app_player_results with (security_invoker = true) as
select r.season, r.week, r.player_id, coalesce(pl.display_name, r.team || ' defense') as name, r.position as pos, r.team,
       r.dk, r.ppr, r.proj_dk, r.proj_p10, r.proj_p90, r.dk - r.proj_dk as miss
from bsb.player_results r
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = r.player_id
where r.sport = 'nfl' and r.proj_dk is not null;

-- one row per settled player bet line: the last price seen for it and how it came out
create view public.app_prop_results with (security_invoker = true) as
select distinct on (p.season, p.week, p.player_id, p.stat, p.line, p.bookmaker)
       p.season, p.week, p.player_id, pl.display_name as name, p.team, p.stat, p.line, p.bookmaker,
       p.over_decimal, p.under_decimal, p.proj_mean, p.model_over, p.novig_over, p.actual,
       case when p.actual > p.line then 'over' when p.actual < p.line then 'under' else 'push' end as came_in,
       case when p.over_decimal  is not null and p.model_over * p.over_decimal - 1 >= 0.05 then 'over'
            when p.under_decimal is not null and (1 - p.model_over) * p.under_decimal - 1 >= 0.05 then 'under' end as model_side
from bsb.prop_prices p
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = p.player_id
where p.actual is not null
order by p.season, p.week, p.player_id, p.stat, p.line, p.bookmaker, p.captured_at desc nulls last, p.run_id desc;

drop view if exists public.app_overrides;
create view public.app_overrides with (security_invoker = true) as
select o.season, o.week, o.player_id, coalesce(pl.display_name, replace(o.player_id, 'DST_', '') || ' defense') as name,
       coalesce(p.position, pl.position) as pos, coalesce(p.team, pl.latest_team) as team, p.opponent,
       o.dk_mean, p.dk_mean as model_dk_mean, o.note, o.updated_at,
       (o.season, o.week) = (select w.season, w.week from bsb.current_week() w) as this_week
from bsb.projection_overrides o
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = o.player_id
left join bsb.projections_latest p on p.player_id = o.player_id and p.season = o.season and p.week = o.week;

drop view if exists public.app_model_runs;
create view public.app_model_runs with (security_invoker = true) as
select r.id, r.created_at, r.model_version, r.season, r.week, r.n_players, r.n_ruled_out, r.metrics, r.git_sha
from bsb.model_runs r order by r.created_at desc limit 30;

drop view if exists public.app_waiver_run;
create view public.app_waiver_run with (security_invoker = true) as
select r.id, r.league_id, r.created_at, r.week, r.teams_left, r.budget, r.chop, r.win, r.teams, r.drops,
       r.lineup, r.coming, r.advice, r.grade
from bsb.waiver_runs r order by r.created_at desc limit 1;

do $$
declare v text;
begin
    foreach v in array array['app_model_dists', 'app_player_results', 'app_prop_results', 'app_overrides',
                             'app_model_runs', 'app_waiver_run'] loop
        execute format('revoke all on public.%I from public, anon, authenticated', v);
        execute format('grant select on public.%I to authenticated', v);
    end loop;
end $$;
