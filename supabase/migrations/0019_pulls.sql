-- Big Surf Bets — the league read every hour, and "pull now" for the league and for prices
--
-- * Sleeper's API is free and keyless, so the league is read hourly (its own
--   workflow, league.yml, so it never queues behind an injury-status wave). A
--   snapshot is stored only when a roster, a lineup or a transaction changed.
-- * The app can ask for a league pull (new job kind refresh_league) as it could
--   already ask for prices (refresh_odds).
-- * OddsPapi's free plan is 250 requests a month and a pull costs about seven.
--   bsb.oddspapi_budget() says how many pulls are spare once the timetable's own
--   pulls for the rest of the month are set aside; an on-demand pull that is not
--   spare skips OddsPapi and still refreshes game lines from OddsLink.
--   The month is taken as the calendar month (UTC).

begin;

-- ---------------------------------------------------------------------------
-- 1. one more job the app can ask for
-- ---------------------------------------------------------------------------
alter table bsb.app_jobs drop constraint if exists app_jobs_kind_check;
alter table bsb.app_jobs add constraint app_jobs_kind_check
    check (kind in ('build_lineups', 'import_slate', 'refresh_status', 'refresh_odds', 'refresh_stats', 'refresh_league',
                    'project', 'notify_test'));

create or replace function bsb.app_jobs_dispatch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare wf text; inputs jsonb; req bigint;
begin
    if new.status <> 'queued' then return new; end if;
    if new.kind in ('build_lineups', 'import_slate', 'notify_test') then
        wf := 'app-jobs.yml'; inputs := jsonb_build_object('job_id', new.id::text);
    elsif new.kind = 'project' then
        wf := 'projections.yml'; inputs := jsonb_build_object('app_job_id', new.id::text);
    elsif new.kind = 'refresh_league' then
        wf := 'league.yml'; inputs := jsonb_build_object('app_job_id', new.id::text);
    else
        wf := 'weekly-ingest.yml';
        inputs := jsonb_build_object('jobs', replace(new.kind, 'refresh_', ''), 'app_job_id', new.id::text);
    end if;
    req := bsb.dispatch_github(wf, inputs, 'app');
    if req is null then
        new.status := 'needs_setup';
        new.error := 'No GitHub token in Supabase Vault (github_pat): the job is saved but nothing was started.';
    else
        new.status := 'dispatched';
        new.dispatch_request_id := req;
    end if;
    return new;
end $$;
revoke all on function bsb.app_jobs_dispatch() from public, anon, authenticated;

-- A second tap while a pull is still on its way joins it instead of starting another.
create or replace function public.bsb_request_job(p_kind text, p_payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member(); new_id bigint;
begin
    if p_kind like 'refresh\_%' then
        select id into new_id from bsb.app_jobs
        where kind = p_kind and status in ('queued', 'dispatched', 'running') and created_at > now() - interval '10 minutes'
        order by created_at desc limit 1;
        if new_id is not null then return new_id; end if;
    end if;
    if (select count(*) from bsb.app_jobs where created_at > now() - interval '1 hour') >= 30 then
        raise exception 'too many requests in the last hour';
    end if;
    insert into bsb.app_jobs (user_id, kind, payload) values (uid, p_kind, coalesce(p_payload, '{}'::jsonb))
    returning id into new_id;
    return new_id;
end $$;
revoke all on function public.bsb_request_job(text, jsonb) from public, anon;
grant execute on function public.bsb_request_job(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. OddsPapi's monthly allowance
-- ---------------------------------------------------------------------------
-- monthly   the plan's requests a month (bsb.app_config 'oddspapi_monthly', default 250)
-- used      requests spent this calendar month, failed pulls included
-- per_pull  what the last complete pull cost (3 look-ups + one per sportsbook)
-- reserved  what the timetable still needs this month: Thursday and Monday before
--           kickoff, Saturday night and Sunday morning (migration 0007)
-- pulls_left  on-demand pulls that fit in what remains
create or replace function bsb.oddspapi_budget(
    out monthly int, out used int, out per_pull int, out reserved int, out pulls_left int)
language sql stable security definer set search_path = '' as $$   -- definer: reads bsb.app_config
    with m as (
        select date_trunc('month', now() at time zone 'utc') as starts,
               (now() at time zone 'utc')::date as today),
    n as (
        select coalesce((select nullif(value, '')::int from bsb.app_config where key = 'oddspapi_monthly'), 250) as monthly,
               coalesce((select sum((r.detail->>'api_calls')::int) from bsb.ingest_runs r, m
                         where r.job = 'odds.oddspapi' and r.detail ? 'api_calls'
                           and r.started_at >= m.starts at time zone 'utc'), 0)::int as used,
               greatest(coalesce((select (r.detail->>'api_calls')::int from bsb.ingest_runs r
                                  where r.job = 'odds.oddspapi' and r.ok and r.detail ? 'api_calls'
                                  order by r.started_at desc limit 1), 7), 1) as per_pull,
               (select coalesce(sum(case extract(dow from d) when 0 then 2 when 1 then 1 when 4 then 1 else 0 end), 0)::int
                from m, generate_series(m.today::timestamp, m.starts + interval '1 month' - interval '1 day', interval '1 day') d) as scheduled)
    select n.monthly, n.used, n.per_pull, n.scheduled * n.per_pull,
           greatest((n.monthly - n.used - n.scheduled * n.per_pull) / n.per_pull, 0)
    from n;
$$;
revoke all on function bsb.oddspapi_budget() from public, anon;
grant execute on function bsb.oddspapi_budget() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. when each feed the app can pull was last read
-- ---------------------------------------------------------------------------
-- checked_at: the last successful read. changed_at: the last read that stored
-- something (the league stores nothing when nothing moved).
drop view if exists public.app_pull_status;
create view public.app_pull_status with (security_invoker = true) as
select j.job, j.label,
       (select max(r.finished_at) from bsb.ingest_runs r where r.job = j.job and r.ok) as checked_at,
       (select max(r.finished_at) from bsb.ingest_runs r where r.job = j.job and r.ok and coalesce(r.rows_written, 0) > 0) as changed_at,
       b.monthly, b.used, b.reserved, b.pulls_left
from (values ('sleeper.league', 'Sleeper league'), ('odds.oddslink', 'Game lines'), ('odds.oddspapi', 'Props and sharp lines')) as j(job, label)
left join lateral (select * from bsb.oddspapi_budget()) b on j.job = 'odds.oddspapi'
where (select bsb.is_member());
revoke all on public.app_pull_status from public, anon, authenticated;
grant select on public.app_pull_status to authenticated;

-- ---------------------------------------------------------------------------
-- 4. the league, every hour (35 past: clear of the status waves at :10 and :40)
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_extension where extname = 'pg_cron')
       or not exists (select 1 from pg_extension where extname = 'pg_net') then
        raise notice 'pg_cron / pg_net not installed here: hourly league pull not scheduled';
        return;
    end if;
    begin
        if exists (select 1 from cron.job where jobname = 'bsb-league') then
            perform cron.unschedule('bsb-league');
        end if;
        perform cron.schedule('bsb-league', '35 * * * *',
            $c$select bsb.dispatch_github('league.yml', '{}'::jsonb, 'bsb-league')$c$);
    exception when others then
        raise warning 'hourly league pull not scheduled: %', sqlerrm;
    end;
end $$;

commit;
