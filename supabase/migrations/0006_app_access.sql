-- Big Surf Bets — app access (Phase 4)
--
-- Until now every bsb table was readable by Supabase's `anon` role and had no
-- row-level security: fine while only GitHub Actions touched the database, not
-- fine once a web app ships the public key. This migration
--
--   1. takes everything away from `anon` and turns row-level security on for
--      every bsb table: only signed-in accounts listed in bsb.app_users read data;
--   2. keeps the bsb schema private and gives the app one small, explicit surface
--      in `public`: read-only app_* views and a handful of bsb_* functions;
--   3. adds the tables the app writes through those functions: jobs it asks the
--      pipeline to run, projection overrides, per-user settings.
--
-- GitHub Actions connects as the table owner and is unaffected.

begin;

-- ---------------------------------------------------------------------------
-- 1. who may use the app
-- ---------------------------------------------------------------------------
create table if not exists bsb.app_users (
    user_id  uuid primary key,                       -- auth.users.id
    email    text,
    role     text not null default 'member',         -- owner / member
    added_at timestamptz not null default now()
);

create table if not exists bsb.app_config (
    key   text primary key,
    value text not null
);
insert into bsb.app_config (key, value) values ('github_repo', 'kl26436/BigSurf-Bets')
on conflict (key) do nothing;

create or replace function bsb.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from bsb.app_users u where u.user_id = (select auth.uid()));
$$;

-- The Sleeper league tables were created on the fly by the ingest (ensure_schema);
-- a fresh database must get them from the migrations like everything else.
create table if not exists bsb.fantasy_leagues (
    league_id   text primary key,
    platform    text not null default 'sleeper',
    name        text,
    season      int,
    total_rosters int,
    scoring     jsonb,
    roster_positions text[],
    settings    jsonb,
    updated_at  timestamptz not null default now()
);
create table if not exists bsb.fantasy_roster_snapshots (
    id            bigserial primary key,
    league_id     text not null references bsb.fantasy_leagues(league_id),
    captured_at   timestamptz not null default now(),
    week          int,
    roster_id     int not null,
    owner_user_id text,
    owner_name    text,
    is_me         boolean not null default false,
    starters      text[],
    players       text[],
    reserve       text[],
    wins int, losses int, fpts numeric(8,2),
    raw           jsonb
);
create index if not exists frs_league_idx on bsb.fantasy_roster_snapshots (league_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- 2. lock the schema down
-- ---------------------------------------------------------------------------
revoke all on all tables in schema bsb from anon, authenticated;
revoke all on all sequences in schema bsb from anon, authenticated;
revoke all on all functions in schema bsb from anon, authenticated, public;
revoke usage on schema bsb from anon;
alter default privileges in schema bsb revoke select on tables from anon, authenticated;
grant usage on schema bsb to authenticated;          -- the app_* views run with the caller's rights
grant execute on function bsb.is_member() to authenticated;

alter table bsb.lineup_sets
    add column if not exists source  text not null default 'auto',   -- auto (pipeline) / user (app request) / manual (built by hand)
    add column if not exists entered boolean not null default false, -- the user says these were actually entered on DraftKings
    add column if not exists job_id  bigint,
    add column if not exists label   text;

-- what a projection run was built from; an identical fingerprint means there is nothing new to project
alter table bsb.model_runs add column if not exists inputs_hash text;

create table if not exists bsb.app_jobs (
    id          bigserial primary key,
    created_at  timestamptz not null default now(),
    user_id     uuid,
    kind        text not null check (kind in ('build_lineups', 'import_slate', 'refresh_status', 'refresh_odds', 'refresh_stats', 'project')),
    payload     jsonb not null default '{}'::jsonb,
    status      text not null default 'queued' check (status in ('queued', 'needs_setup', 'dispatched', 'running', 'done', 'failed')),
    dispatch_request_id bigint,                       -- pg_net request that started the workflow
    started_at  timestamptz,
    finished_at timestamptz,
    result      jsonb,
    error       text
);
create index if not exists app_jobs_status_idx on bsb.app_jobs (status, created_at);

create table if not exists bsb.projection_overrides (
    season     int  not null,
    week       int  not null,
    player_id  text not null,
    dk_mean    numeric(6,2) not null,                 -- the number to use instead of the model's
    note       text,
    user_id    uuid,
    updated_at timestamptz not null default now(),
    primary key (season, week, player_id)
);

create table if not exists bsb.user_settings (
    user_id    uuid primary key,
    settings   jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

-- row-level security on every table; members read, nobody writes directly
do $$
declare t record;
begin
    for t in select tablename from pg_tables where schemaname = 'bsb' loop
        execute format('alter table bsb.%I enable row level security', t.tablename);
        execute format('drop policy if exists members_read on bsb.%I', t.tablename);
        if t.tablename not in ('app_users', 'app_config', 'schema_migrations', 'user_settings') then
            execute format('create policy members_read on bsb.%I for select to authenticated using ((select bsb.is_member()))', t.tablename);
            execute format('grant select on bsb.%I to authenticated', t.tablename);
        end if;
    end loop;
end $$;

-- the existing bsb views must not read with their owner's rights once the app can reach them
alter view bsb.projections_latest set (security_invoker = true);
alter view bsb.odds_latest        set (security_invoker = true);
alter view bsb.prop_edges         set (security_invoker = true);
alter view bsb.line_quotes_latest set (security_invoker = true);
grant select on bsb.projections_latest, bsb.odds_latest, bsb.prop_edges, bsb.line_quotes_latest to authenticated;

-- ---------------------------------------------------------------------------
-- 3. the app's read surface (public.app_*)
-- ---------------------------------------------------------------------------
create or replace function bsb.current_week() returns table (season int, week int)
language sql stable security invoker set search_path = '' as $$
    select r.season, r.week from bsb.model_runs r order by r.created_at desc limit 1;
$$;
grant execute on function bsb.current_week() to authenticated;

drop view if exists public.app_feed_health, public.app_slates, public.app_pool, public.app_projections,
    public.app_games, public.app_lineup_sets, public.app_lineups, public.app_lineup_players,
    public.app_line_quotes, public.app_prop_edges, public.app_scorecards, public.app_player_log,
    public.app_my_roster, public.app_free_agents, public.app_jobs, public.app_overrides, public.app_model_runs;

create view public.app_feed_health with (security_invoker = true) as
with expect (job, label, max_age_hours, sort) as (values
    ('nflverse.player_stats',  'Game stats',          100, 1),
    ('nflverse.injuries',      'Injury reports',      100, 2),
    ('sleeper.status',         'Player statuses',      40, 3),
    ('odds.oddslink',          'Game lines',           80, 4),
    ('odds.oddspapi',          'Props and sharp lines', 80, 5),
    ('model.project',          'Projections',          40, 6),
    ('optimizer.lineups',      'Lineups',             100, 7)),
last_ok as (
    select distinct on (job) job, finished_at, rows_written
    from bsb.ingest_runs where ok and coalesce(rows_written, 0) > 0 order by job, finished_at desc),
last_any as (
    select distinct on (job) job, started_at, ok, detail->>'error' as error
    from bsb.ingest_runs order by job, started_at desc)
select e.job, e.label, e.sort, o.finished_at as last_ok_at, o.rows_written as last_rows,
       round((extract(epoch from now() - o.finished_at) / 3600.0)::numeric, 1) as age_hours, e.max_age_hours,
       case when o.finished_at is null then 'never'
            when now() - o.finished_at > make_interval(hours => e.max_age_hours) then 'stale'
            when a.ok is false then 'failing' else 'ok' end as state,
       case when a.ok is false then a.error end as last_error
from expect e left join last_ok o using (job) left join last_any a using (job);

create view public.app_model_runs with (security_invoker = true) as
select r.id, r.created_at, r.model_version, r.season, r.week, r.n_players, r.n_ruled_out, r.metrics, r.git_sha
from bsb.model_runs r;

create view public.app_slates with (security_invoker = true) as
select sl.id, sl.slate_name, sl.slate_type, sl.season, sl.week, sl.starts_at, sl.salary_cap, sl.imported_at,
       sl.starts_at > now() as upcoming,
       (select count(*) from bsb.dfs_salaries s where s.slate_id = sl.id) as n_players,
       (select count(distinct s.game_id) from bsb.dfs_salaries s where s.slate_id = sl.id) as n_games
from bsb.dfs_slates sl;

create view public.app_pool with (security_invoker = true) as
select s.slate_id, s.site_player_id as dk_id, s.player_id, s.player_name as name, s.position as pos, s.team, s.opponent,
       s.game_id, g.kickoff_at, s.salary, s.avg_points, nullif(s.raw->>'Status', '') as dk_status, pl.headshot_url,
       p.run_id, p.projected_at, p.injury_status,
       p.dk_mean as model_dk_mean, o.dk_mean as override_dk_mean, o.note as override_note,
       coalesce(o.dk_mean, p.dk_mean) as dk_mean,
       p.dk_std, p.dk_p10, p.dk_p25, p.dk_p50, p.dk_p75, p.dk_p90, p.ppr_mean, p.anytime_td_prob,
       p.attempts, p.completions, p.passing_yards, p.passing_tds, p.interceptions, p.carries, p.rushing_yards,
       p.rushing_tds, p.targets, p.receptions, p.receiving_yards, p.receiving_tds,
       p.dst_sacks, p.dst_interceptions, p.dst_fumble_recoveries, p.dst_tds, p.dst_points_allowed,
       case when g.home_team = s.team then (g.total_line + g.spread_line) / 2 else (g.total_line - g.spread_line) / 2 end as implied_total,
       case when g.home_team = s.team then -g.spread_line else g.spread_line end as team_spread,
       g.total_line
from bsb.dfs_salaries s
join bsb.dfs_slates sl on sl.id = s.slate_id
left join bsb.games g on g.sport = 'nfl' and g.game_id = s.game_id
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = s.player_id
left join bsb.projections_latest p on p.player_id = s.player_id and p.season = sl.season and p.week = sl.week
left join bsb.projection_overrides o on o.player_id = s.player_id and o.season = sl.season and o.week = sl.week;

create view public.app_projections with (security_invoker = true) as
select p.season, p.week, p.player_id, coalesce(pl.display_name, p.team || ' DST') as name, p.position as pos, p.team,
       p.opponent, p.game_id, g.kickoff_at, pl.headshot_url, p.injury_status, p.run_id, p.projected_at, p.model_version,
       p.dk_mean as model_dk_mean, o.dk_mean as override_dk_mean, coalesce(o.dk_mean, p.dk_mean) as dk_mean,
       p.dk_std, p.dk_p10, p.dk_p25, p.dk_p50, p.dk_p75, p.dk_p90,
       p.ppr_mean, p.ppr_p10, p.ppr_p50, p.ppr_p90, p.anytime_td_prob,
       p.attempts, p.completions, p.passing_yards, p.passing_tds, p.interceptions, p.carries, p.rushing_yards,
       p.rushing_tds, p.targets, p.receptions, p.receiving_yards, p.receiving_tds,
       p.dst_sacks, p.dst_interceptions, p.dst_fumble_recoveries, p.dst_tds, p.dst_points_allowed, p.stat_quantiles,
       case when g.home_team = p.team then (g.total_line + g.spread_line) / 2 else (g.total_line - g.spread_line) / 2 end as implied_total,
       case when g.home_team = p.team then -g.spread_line else g.spread_line end as team_spread
from bsb.projections_latest p
join bsb.current_week() w on w.season = p.season and w.week = p.week
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = p.player_id
left join bsb.games g on g.sport = 'nfl' and g.game_id = p.game_id
left join bsb.projection_overrides o on o.player_id = p.player_id and o.season = p.season and o.week = p.week;

create view public.app_games with (security_invoker = true) as
select g.game_id, g.season, g.week, g.kickoff_at, g.home_team, g.away_team, g.home_score, g.away_score,
       g.spread_line, g.total_line, g.home_moneyline, g.away_moneyline, g.roof,
       (g.total_line + g.spread_line) / 2 as home_implied, (g.total_line - g.spread_line) / 2 as away_implied
from bsb.games g join bsb.current_week() w on w.season = g.season and w.week = g.week
where g.sport = 'nfl';

create view public.app_lineup_sets with (security_invoker = true) as
select ls.id, ls.created_at, ls.slate_id, ls.run_id, ls.mode, ls.source, ls.entered, ls.label, ls.job_id, ls.n_lineups,
       ls.settings, ls.summary,
       ls.run_id is not distinct from (
           select r.id from bsb.model_runs r join bsb.dfs_slates sl on sl.id = ls.slate_id
           where r.season = sl.season and r.week = sl.week order by r.created_at desc limit 1) as on_latest_projections
from bsb.lineup_sets ls;

create view public.app_lineups with (security_invoker = true) as
select l.set_id, l.lineup_no, l.salary, l.proj, l.sim_mean, l.sim_std, l.p10, l.p50, l.p90, l.p99, l.best_of_set_pct, l.actual_points
from bsb.lineups l;

create view public.app_lineup_players with (security_invoker = true) as
select lp.set_id, lp.lineup_no, lp.slot_no, lp.slot, lp.site_player_id as dk_id, lp.player_id, lp.player_name as name,
       lp.position as pos, lp.team, lp.opponent, lp.salary, lp.dk_mean, lp.status
from bsb.lineup_players lp;

create view public.app_line_quotes with (security_invoker = true) as
select q.captured_at, q.game_id, g.home_team, g.away_team, g.kickoff_at, q.market, q.number, q.outcome, q.line,
       q.bookmaker, q.price_american, q.price_decimal, q.hold, q.fair_prob, q.ev, q.is_best, q.arb_pct
from bsb.line_quotes_latest q join bsb.games g on g.sport = 'nfl' and g.game_id = q.game_id;

create view public.app_prop_edges with (security_invoker = true) as
select e.season, e.week, e.game_id, e.player_id, e.player_name, e.team, e.stat, e.line, e.bookmaker, e.over_decimal,
       e.under_decimal, e.hold, e.proj_mean, e.model_over, e.fair_over, e.ev_over_fair, e.ev_under_fair,
       e.ev_over_model, e.ev_under_model, e.captured_at
from bsb.prop_edges e join bsb.current_week() w on w.season = e.season and w.week = e.week;

create view public.app_scorecards with (security_invoker = true) as
select s.season, s.week, s.created_at, s.metrics from bsb.scorecards s;

create view public.app_player_log with (security_invoker = true) as
select w.player_id, w.season, w.week, w.season_type, w.team, w.opponent, w.position, w.completions, w.attempts,
       w.passing_yards, w.passing_tds, w.interceptions, w.carries, w.rushing_yards, w.rushing_tds, w.targets,
       w.receptions, w.receiving_yards, w.receiving_tds, w.fumbles_lost, w.target_share,
       w.fantasy_points_dk, w.fantasy_points_ppr
from bsb.player_week_stats w where w.sport = 'nfl';

create view public.app_my_roster with (security_invoker = true) as
with me as (
    select r.* from bsb.fantasy_roster_snapshots r where r.is_me order by r.captured_at desc limit 1),
ids as (
    select unnest(m.players) as sleeper_id, m.starters, m.captured_at, m.league_id, m.week from me m)
select i.league_id, i.captured_at, i.sleeper_id,
       coalesce(pl.player_id, case when i.sleeper_id ~ '^[A-Z]{2,3}$' then 'DST_' || replace(i.sleeper_id, 'LAR', 'LA') end) as player_id,
       coalesce(pl.display_name, i.sleeper_id || ' DST') as name,
       coalesce(pl.position, case when i.sleeper_id ~ '^[A-Z]{2,3}$' then 'DST' end) as pos,
       coalesce(p.team, pl.latest_team) as team, i.sleeper_id = any (i.starters) as is_starter,
       p.opponent, g.kickoff_at, p.ppr_mean, p.ppr_p10, p.ppr_p90, p.dk_mean, p.injury_status, pl.headshot_url
from ids i
left join bsb.players pl on pl.sport = 'nfl' and pl.sleeper_id = i.sleeper_id
left join bsb.current_week() w on true
left join bsb.projections_latest p on p.season = w.season and p.week = w.week
     and p.player_id = coalesce(pl.player_id, 'DST_' || replace(i.sleeper_id, 'LAR', 'LA'))
left join bsb.games g on g.sport = 'nfl' and g.game_id = p.game_id;

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
  and not exists (select 1 from taken t where t.sleeper_id = pl.sleeper_id);

create view public.app_jobs with (security_invoker = true) as
select j.id, j.created_at, j.kind, j.payload - 'csv' as payload, j.status, j.started_at, j.finished_at, j.result, j.error
from bsb.app_jobs j;

create view public.app_overrides with (security_invoker = true) as
select o.season, o.week, o.player_id, o.dk_mean, o.note, o.updated_at from bsb.projection_overrides o;

do $$
declare v text;
begin
    foreach v in array array['app_feed_health', 'app_model_runs', 'app_slates', 'app_pool', 'app_projections', 'app_games',
        'app_lineup_sets', 'app_lineups', 'app_lineup_players', 'app_line_quotes', 'app_prop_edges', 'app_scorecards',
        'app_player_log', 'app_my_roster', 'app_free_agents', 'app_jobs', 'app_overrides'] loop
        execute format('revoke all on public.%I from public, anon, authenticated', v);
        execute format('grant select on public.%I to authenticated', v);
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. the app's write surface (public.bsb_* functions; each checks membership)
-- ---------------------------------------------------------------------------
create or replace function public.bsb_whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'signed_in', (select auth.uid()) is not null,
        'member', bsb.is_member(),
        'role', (select u.role from bsb.app_users u where u.user_id = (select auth.uid())),
        'claim_open', not exists (select 1 from bsb.app_users));
$$;

-- The first account to sign in claims the app; after that the door is shut and
-- further people are added by the owner (insert into bsb.app_users).
create or replace function public.bsb_claim_owner() returns text
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
    if uid is null then raise exception 'not signed in'; end if;
    perform pg_advisory_xact_lock(4207001);
    if exists (select 1 from bsb.app_users) then
        return case when exists (select 1 from bsb.app_users where user_id = uid) then 'member' else 'closed' end;
    end if;
    insert into bsb.app_users (user_id, email, role) values (uid, (select auth.jwt()) ->> 'email', 'owner');
    return 'owner';
end $$;

create or replace function bsb.require_member() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
    if not bsb.is_member() then raise exception 'not allowed' using errcode = '42501'; end if;
    return (select auth.uid());
end $$;

create or replace function public.bsb_request_job(p_kind text, p_payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member(); new_id bigint;
begin
    if (select count(*) from bsb.app_jobs where created_at > now() - interval '1 hour') >= 30 then
        raise exception 'too many requests in the last hour';
    end if;
    insert into bsb.app_jobs (user_id, kind, payload) values (uid, p_kind, coalesce(p_payload, '{}'::jsonb))
    returning id into new_id;
    return new_id;
end $$;

create or replace function public.bsb_set_entered(p_set_id bigint, p_entered boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    update bsb.lineup_sets set entered = p_entered where id = p_set_id;
end $$;

create or replace function public.bsb_set_override(p_season int, p_week int, p_player_id text, p_dk_mean numeric, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member();
begin
    if p_dk_mean is null then
        delete from bsb.projection_overrides where season = p_season and week = p_week and player_id = p_player_id;
    elsif p_dk_mean < 0 or p_dk_mean > 80 then
        raise exception 'projection out of range';
    else
        insert into bsb.projection_overrides (season, week, player_id, dk_mean, note, user_id)
        values (p_season, p_week, p_player_id, p_dk_mean, p_note, uid)
        on conflict (season, week, player_id) do update
            set dk_mean = excluded.dk_mean, note = excluded.note, user_id = excluded.user_id, updated_at = now();
    end if;
end $$;

-- Save a lineup built by hand. p_players: nine DraftKings ids in slot order
-- (QB RB RB WR WR WR TE FLEX DST). Checked here as well as in the app.
create or replace function public.bsb_save_lineup(p_slate_id bigint, p_players text[], p_label text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
    uid uuid := bsb.require_member();
    slots text[] := array['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'];
    cap int; new_set bigint; total int; n int; n_distinct int; n_games int; bad int;
begin
    select salary_cap into cap from bsb.dfs_slates where id = p_slate_id and slate_type = 'classic';
    if cap is null then raise exception 'unknown classic slate'; end if;
    if coalesce(array_length(p_players, 1), 0) <> 9 then raise exception 'a lineup has nine players'; end if;
    select count(*), count(distinct s.site_player_id), sum(s.salary), count(distinct s.game_id),
           count(*) filter (where not (s.position = slots[x.ord] or (slots[x.ord] = 'FLEX' and s.position in ('RB', 'WR', 'TE'))))
      into n, n_distinct, total, n_games, bad
      from unnest(p_players) with ordinality as x(dk_id, ord)
      join bsb.dfs_salaries s on s.slate_id = p_slate_id and s.site_player_id = x.dk_id;
    if n <> 9 or n_distinct <> 9 then raise exception 'players must be nine different players from this slate'; end if;
    if bad > 0 then raise exception 'a player is in a slot his position cannot fill'; end if;
    if total > cap then raise exception 'over the salary cap'; end if;
    if n_games < 2 then raise exception 'players must come from at least two games'; end if;

    insert into bsb.lineup_sets (slate_id, run_id, mode, n_lineups, settings, summary, source, label)
    values (p_slate_id,
            (select r.id from bsb.model_runs r join bsb.dfs_slates sl on sl.id = p_slate_id
             where r.season = sl.season and r.week = sl.week order by r.created_at desc limit 1),
            'manual', 1, jsonb_build_object('user_id', uid), '{}'::jsonb, 'manual', p_label)
    returning id into new_set;
    insert into bsb.lineups (set_id, lineup_no, salary, proj)
    select new_set, 1, total, (
        select round(sum(coalesce(o.dk_mean, p.dk_mean))::numeric, 2)
        from unnest(p_players) d join bsb.dfs_salaries s on s.slate_id = p_slate_id and s.site_player_id = d
        join bsb.dfs_slates sl on sl.id = s.slate_id
        left join bsb.projections_latest p on p.player_id = s.player_id and p.season = sl.season and p.week = sl.week
        left join bsb.projection_overrides o on o.player_id = s.player_id and o.season = sl.season and o.week = sl.week);
    insert into bsb.lineup_players (set_id, lineup_no, slot_no, slot, site_player_id, player_id, player_name, position, team, opponent, salary, dk_mean, status)
    select new_set, 1, x.ord - 1, slots[x.ord], s.site_player_id, s.player_id, s.player_name, s.position, s.team, s.opponent,
           s.salary, coalesce(o.dk_mean, p.dk_mean), nullif(s.raw->>'Status', '')
    from unnest(p_players) with ordinality as x(dk_id, ord)
    join bsb.dfs_salaries s on s.slate_id = p_slate_id and s.site_player_id = x.dk_id
    join bsb.dfs_slates sl on sl.id = s.slate_id
    left join bsb.projections_latest p on p.player_id = s.player_id and p.season = sl.season and p.week = sl.week
    left join bsb.projection_overrides o on o.player_id = s.player_id and o.season = sl.season and o.week = sl.week;
    return new_set;
end $$;

create or replace function public.bsb_get_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
    select coalesce((select s.settings from bsb.user_settings s where s.user_id = (select auth.uid()) and bsb.is_member()), '{}'::jsonb);
$$;

create or replace function public.bsb_save_settings(p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member();
begin
    if pg_column_size(p_settings) > 16000 then raise exception 'settings too large'; end if;
    insert into bsb.user_settings (user_id, settings) values (uid, p_settings)
    on conflict (user_id) do update set settings = excluded.settings, updated_at = now();
end $$;

revoke all on function bsb.require_member() from public, anon, authenticated;
do $$
declare f text;
begin
    foreach f in array array['bsb_whoami()', 'bsb_claim_owner()', 'bsb_request_job(text, jsonb)', 'bsb_set_entered(bigint, boolean)',
        'bsb_set_override(int, int, text, numeric, text)', 'bsb_save_lineup(bigint, text[], text)', 'bsb_get_settings()',
        'bsb_save_settings(jsonb)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;

commit;
