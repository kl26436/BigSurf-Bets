-- Big Surf Bets — what changed, and telling you about it.
--
-- The pipeline already notices when a player is ruled out; nothing told anyone.
-- This adds:
--   events          what changed since the last look (a player in an entered lineup ruled
--                   out, a status change, expected points moving): the "What changed" list
--   push_subscriptions   the devices that asked for a pop-up (the home-screen app on a phone)
--   notifications   what was sent, to which device or address, and whether it arrived
-- The pipeline writes events and sends; the app only reads them and registers a device.
-- The keys that sign pop-ups live in bsb.app_config, which no app account can read.
--
-- Adds three tables, three views and four functions; one function and one check are widened.
-- Deletes nothing.

begin;

create table if not exists bsb.events (
    id          bigint generated always as identity primary key,
    created_at  timestamptz not null default now(),
    kind        text not null check (kind in ('scratch', 'status', 'points', 'test')),
    dedupe_key  text not null unique,              -- the same change is recorded once
    severity    text not null default 'info' check (severity in ('info', 'alert')),
    title       text not null,
    body        text,
    url         text,                              -- where in the app to go
    slate_id    bigint,
    player_id   text,
    data        jsonb not null default '{}'::jsonb
);
create index if not exists events_created_idx on bsb.events (created_at desc);

create table if not exists bsb.push_subscriptions (
    endpoint    text primary key,                  -- the push service's address for one device
    user_id     uuid not null,
    p256dh      text not null,
    auth        text not null,
    device      text,                              -- "iPhone", "Mac" … as the app described it
    created_at  timestamptz not null default now(),
    last_ok_at  timestamptz,
    failed_at   timestamptz,
    failures    int not null default 0
);
create index if not exists push_subscriptions_user_idx on bsb.push_subscriptions (user_id);

create table if not exists bsb.notifications (
    id          bigint generated always as identity primary key,
    at          timestamptz not null default now(),
    event_id    bigint not null references bsb.events(id) on delete cascade,
    user_id     uuid not null,
    channel     text not null check (channel in ('push', 'email')),
    target      text not null,                     -- the device's label, or the address with its name masked
    status      text not null check (status in ('sent', 'failed', 'skipped')),
    error       text
);
create index if not exists notifications_user_idx on bsb.notifications (user_id, at desc);

alter table bsb.events enable row level security;
alter table bsb.push_subscriptions enable row level security;
alter table bsb.notifications enable row level security;
drop policy if exists members_read on bsb.events;
create policy members_read on bsb.events for select to authenticated using ((select bsb.is_member()));
drop policy if exists own_read on bsb.push_subscriptions;
create policy own_read on bsb.push_subscriptions for select to authenticated using (user_id = (select auth.uid()) and (select bsb.is_member()));
drop policy if exists own_read on bsb.notifications;
create policy own_read on bsb.notifications for select to authenticated using (user_id = (select auth.uid()) and (select bsb.is_member()));
revoke all on bsb.events, bsb.push_subscriptions, bsb.notifications from anon, authenticated;
grant select on bsb.events, bsb.notifications to authenticated;
grant select (endpoint, user_id, device, created_at, last_ok_at, failed_at, failures) on bsb.push_subscriptions to authenticated;   -- never the keys
grant all on bsb.events, bsb.push_subscriptions, bsb.notifications to service_role;

-- what the app lists
create or replace view public.app_events with (security_invoker = true) as
select e.id, e.created_at, e.kind, e.severity, e.title, e.body, e.url, e.slate_id, e.player_id
from bsb.events e
where e.created_at > now() - interval '14 days' and e.kind <> 'test';

create or replace view public.app_push_devices with (security_invoker = true) as
-- id: the SHA-256 of the device's push address, so the app can tell which row is the device in hand
select encode(sha256(convert_to(s.endpoint, 'UTF8')), 'hex') as id, s.device, s.created_at, s.last_ok_at, s.failed_at, s.failures
from bsb.push_subscriptions s;

create or replace view public.app_notifications with (security_invoker = true) as
select n.id, n.at, n.channel, n.target, n.status, n.error, e.kind, e.title
from bsb.notifications n join bsb.events e on e.id = n.event_id;

revoke all on public.app_events, public.app_push_devices, public.app_notifications from public, anon, authenticated;
grant select on public.app_events, public.app_push_devices, public.app_notifications to authenticated;

-- ---------------------------------------------------------------------------
-- a device signs up for pop-ups
-- ---------------------------------------------------------------------------
-- The public half of the signing key (null until the pipeline has made the pair).
create or replace function public.bsb_push_key() returns text
language plpgsql stable security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    return (select value from bsb.app_config where key = 'vapid_public');
end $$;

create or replace function public.bsb_save_push_subscription(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member();
begin
    if coalesce(p->>'endpoint', '') !~ '^https://' or length(p->>'endpoint') > 2000
       or coalesce(p->'keys'->>'p256dh', '') = '' or coalesce(p->'keys'->>'auth', '') = '' then
        raise exception 'that is not a push subscription';
    end if;
    if (select count(*) from bsb.push_subscriptions where user_id = uid) >= 12
       and not exists (select 1 from bsb.push_subscriptions where endpoint = p->>'endpoint') then
        raise exception 'too many devices: turn one off first';
    end if;
    insert into bsb.push_subscriptions (endpoint, user_id, p256dh, auth, device)
    values (p->>'endpoint', uid, p->'keys'->>'p256dh', p->'keys'->>'auth', left(nullif(trim(p->>'device'), ''), 60))
    on conflict (endpoint) do update
        set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device,
            failed_at = null, failures = 0;
end $$;

-- by the address itself (this device turning pop-ups off) or by the id the app lists (any of your devices)
create or replace function public.bsb_delete_push_subscription(p_endpoint text default null, p_id text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member(); n int;
begin
    delete from bsb.push_subscriptions
     where user_id = uid and ((p_endpoint is not null and endpoint = p_endpoint) or (p_id is not null and encode(sha256(convert_to(endpoint, 'UTF8')), 'hex') = p_id));
    get diagnostics n = row_count;
    return n;
end $$;

revoke all on function public.bsb_push_key(), public.bsb_save_push_subscription(jsonb),
                       public.bsb_delete_push_subscription(text, text) from public, anon;
grant execute on function public.bsb_push_key(), public.bsb_save_push_subscription(jsonb),
                          public.bsb_delete_push_subscription(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- "send me a test" is one more job the app can ask for
-- ---------------------------------------------------------------------------
alter table bsb.app_jobs drop constraint if exists app_jobs_kind_check;
alter table bsb.app_jobs add constraint app_jobs_kind_check
    check (kind in ('build_lineups', 'import_slate', 'refresh_status', 'refresh_odds', 'refresh_stats', 'project', 'notify_test'));

create or replace function bsb.app_jobs_dispatch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare wf text; inputs jsonb; req bigint;
begin
    if new.status <> 'queued' then return new; end if;
    if new.kind in ('build_lineups', 'import_slate', 'notify_test') then
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

commit;
