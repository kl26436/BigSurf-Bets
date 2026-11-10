-- Big Surf Bets — scheduler and app → pipeline dispatch
--
-- GitHub's own cron proved unreliable (the first scheduled ingest never fired),
-- and the app needs a way to start pipeline work. Both are solved the same way:
-- the database asks GitHub to run a workflow (workflow_dispatch) through pg_net,
-- on a pg_cron timetable and whenever the app files a job.
--
-- Needs one secret that only the repo owner can create: a fine-grained GitHub
-- token with "Actions: read and write" on this repository, stored in Supabase
-- Vault under the name  github_pat . Until it exists nothing is dispatched: jobs
-- are marked needs_setup and the workflows' own (off-the-hour) cron lines carry on.
--
-- Outside Supabase (local Postgres, CI) pg_net / pg_cron / vault are missing;
-- everything below degrades to a no-op.

begin;

create table if not exists bsb.dispatches (
    id         bigserial primary key,
    at         timestamptz not null default now(),
    workflow   text not null,
    inputs     jsonb,
    request_id bigint,                 -- pg_net request id; null = not sent (no token / no pg_net)
    source     text                    -- cron job name or 'app'
);
alter table bsb.dispatches enable row level security;
drop policy if exists members_read on bsb.dispatches;
create policy members_read on bsb.dispatches for select to authenticated using ((select bsb.is_member()));
grant select on bsb.dispatches to authenticated;

create or replace function bsb.dispatch_github(p_workflow text, p_inputs jsonb default '{}'::jsonb, p_source text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare tok text; repo text; req bigint;
begin
    begin
        execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into tok using 'github_pat';
    exception when others then tok := null;
    end;
    if coalesce(tok, '') <> '' then
        select value into repo from bsb.app_config where key = 'github_repo';
        begin
            execute 'select net.http_post(url := $1, headers := $2, body := $3)' into req using
                format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches', repo, p_workflow),
                jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
                                   'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'bigsurf-bets',
                                   'Content-Type', 'application/json'),
                jsonb_build_object('ref', 'main', 'inputs', coalesce(p_inputs, '{}'::jsonb));
        exception when others then req := null;
        end;
    end if;
    insert into bsb.dispatches (workflow, inputs, request_id, source) values (p_workflow, p_inputs, req, p_source);
    return req;
end $$;
revoke all on function bsb.dispatch_github(text, jsonb, text) from public, anon, authenticated;

-- a new app job starts its workflow straight away
create or replace function bsb.app_jobs_dispatch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare wf text; inputs jsonb; req bigint;
begin
    if new.status <> 'queued' then return new; end if;
    if new.kind in ('build_lineups', 'import_slate') then
        wf := 'app-jobs.yml'; inputs := jsonb_build_object('job_id', new.id::text);
    elsif new.kind = 'project' then
        wf := 'projections.yml'; inputs := jsonb_build_object('app_job_id', new.id::text);
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
drop trigger if exists app_jobs_dispatch on bsb.app_jobs;
create trigger app_jobs_dispatch before insert on bsb.app_jobs
    for each row execute function bsb.app_jobs_dispatch();

-- what GitHub answered to the recent dispatches (204 = accepted)
create or replace function public.bsb_recent_dispatches() returns table (
    at timestamptz, workflow text, inputs jsonb, source text, sent boolean, status_code int, error text)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not bsb.is_member() then raise exception 'not allowed' using errcode = '42501'; end if;
    begin
        return query execute
            'select d.at, d.workflow, d.inputs, d.source, d.request_id is not null, r.status_code, r.error_msg
             from bsb.dispatches d left join net._http_response r on r.id = d.request_id
             order by d.at desc limit 40';
    exception when others then
        return query select d.at, d.workflow, d.inputs, d.source, d.request_id is not null, null::int, null::text
                     from bsb.dispatches d order by d.at desc limit 40;
    end;
end $$;
revoke all on function public.bsb_recent_dispatches() from public, anon;
grant execute on function public.bsb_recent_dispatches() to authenticated;

-- Timetable (UTC). Eastern time is UTC-5 from November and UTC-4 before; the
-- Sunday waves are wide enough to cover both. A status snapshot that changes
-- nothing costs a minute of free CI: projections only re-run when their inputs
-- changed.
do $$
declare j record;
begin
    if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
       or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
        raise notice 'pg_cron / pg_net not available here: timetable not installed';
        return;
    end if;
    -- never let the timetable stop a deploy: if anything here fails, the workflows' own cron lines still run
    begin
        execute 'create extension if not exists pg_net';
        execute 'create extension if not exists pg_cron';
        for j in execute $q$select jobname from cron.job where jobname like 'bsb-%'$q$ loop
            execute format('select cron.unschedule(%L)', j.jobname);
        end loop;
        for j in select * from (values
            ('bsb-tue-stats',   '10 11 * * 2',       'stats,league,status'),  -- Tue 06:10 ET: Monday night is in
            ('bsb-wed-status',  '10 22 * * 3',       'status'),               -- Wed 17:10 ET: Thursday game's final report
            ('bsb-thu-pregame', '55 23 * * 4',       'status,odds'),          -- Thu 18:55 ET: inactives + props before kickoff
            ('bsb-fri-status',  '10 22 * * 5',       'status'),               -- Fri 17:10 ET: final injury reports
            ('bsb-sat-stats',   '10 13 * * 6',       'stats,league,status'),  -- Sat 08:10 ET: Friday reports + Thursday stats
            ('bsb-sat-odds',    '5 3 * * 0',         'odds,status'),          -- Sat 22:05 ET
            ('bsb-sun-odds',    '5 15 * * 0',        'odds,status'),          -- Sun 10:05 ET
            ('bsb-sun-waves',   '10,40 15-20 * * 0', 'status'),               -- Sun 10:10-15:40 ET: 1pm and 4pm inactives
            ('bsb-sun-night',   '55 22,23 * * 0',    'status'),               -- Sunday night inactives
            ('bsb-mon-pregame', '55 23 * * 1',       'status,odds')           -- Mon 18:55 ET
        ) as t(name, cron, jobs) loop
            execute format('select cron.schedule(%L, %L, %L)', j.name, j.cron,
                format($c$select bsb.dispatch_github('weekly-ingest.yml', '{"jobs":"%s"}'::jsonb, %L)$c$, j.jobs, j.name));
        end loop;
        -- keep three weeks of dispatch history
        execute format('select cron.schedule(%L, %L, %L)', 'bsb-prune-dispatches', '20 9 * * *',
            $c$delete from bsb.dispatches where at < now() - interval '21 days'$c$);
    exception when others then
        raise warning 'timetable not installed: %', sqlerrm;
    end;
end $$;

commit;
