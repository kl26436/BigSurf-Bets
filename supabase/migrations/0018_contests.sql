-- 0018: DraftKings contest results.
--
-- After a contest, its page offers "Export Lineups to CSV": every entry's rank and
-- points, and beside them every player's share of lineups ("%Drafted") and score. The
-- app reads that file on the device and sends only what is worth keeping:
--
--   contests           one row per contest: field size, the scores it took to place,
--                      the entry fee
--   contest_entries    the user's own entries: rank, points, and what each one won
--                      (typed in: the file does not carry winnings)
--   contest_ownership  how much of the field had each player: the archive an ownership
--                      model needs, and it cannot be had any other way
--
-- A 150,000-entry file is tens of megabytes; what is stored is a few hundred rows.

create table if not exists bsb.contests (
    id          bigserial primary key,
    user_id     uuid,
    slate_id    bigint references bsb.dfs_slates(id) on delete set null,
    site        text not null default 'draftkings',
    contest_key text not null,                    -- DraftKings contest id when the file name carries it, else a fingerprint of the file
    name        text,
    entry_fee   numeric(8,2),
    n_entries   int  not null,
    scores      jsonb,                            -- {max, p99, p90, p75, p50, min}: points by place in the field
    imported_at timestamptz not null default now(),
    unique (site, contest_key)
);

create table if not exists bsb.contest_entries (
    contest_id bigint not null references bsb.contests(id) on delete cascade,
    entry_id   text   not null,
    entry_name text,
    rank       int,
    points     numeric(7,2),
    lineup     text,                              -- as the file writes it: "QB Name RB Name …"
    winnings   numeric(10,2),                     -- null until typed in
    primary key (contest_id, entry_id)
);

create table if not exists bsb.contest_ownership (
    contest_id      bigint not null references bsb.contests(id) on delete cascade,
    player_name     text   not null,
    roster_position text   not null default '',
    player_id       text,                         -- ours, when the name matches a player on the slate
    pct_drafted     numeric(6,2),
    fpts            numeric(7,2),
    primary key (contest_id, player_name, roster_position)
);
create index if not exists contest_ownership_player_idx on bsb.contest_ownership (player_id);

do $$
declare t text;
begin
    foreach t in array array['contests', 'contest_entries', 'contest_ownership'] loop
        execute format('alter table bsb.%I enable row level security', t);
        execute format('drop policy if exists members_read on bsb.%I', t);
        execute format('create policy members_read on bsb.%I for select to authenticated using ((select bsb.is_member()))', t);
        execute format('grant select on bsb.%I to authenticated', t);
        execute format('grant all on bsb.%I to service_role', t);
    end loop;
end $$;
grant all on all sequences in schema bsb to service_role;

-- ---------------------------------------------------------------------------
-- p: {contest_key, name?, entry_fee?, n_entries, scores, entries: [{entry_id, entry_name, rank, points, lineup}],
--     ownership: [{name, roster_position, pct_drafted, fpts}]}
-- Adding the same contest again replaces its numbers and keeps the winnings already typed in.
-- p_slate_id null: the games are worked out from the players in the file.
create or replace function public.bsb_import_contest(p_slate_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    uid uuid := bsb.require_member();
    cid bigint; key text := nullif(trim(p->>'contest_key'), ''); n_mine int; n_own int; fee numeric; nm text;
begin
    if key is null or length(key) > 80 then raise exception 'that file could not be told apart from others (no contest id)'; end if;
    if jsonb_typeof(p->'entries') is distinct from 'array' or jsonb_typeof(p->'ownership') is distinct from 'array' then
        raise exception 'not a contest results file';
    end if;
    if jsonb_array_length(p->'entries') > 500 or jsonb_array_length(p->'ownership') > 2000 or pg_column_size(p) > 600000 then
        raise exception 'too much in one file';
    end if;
    if coalesce((p->>'n_entries')::int, 0) < 1 then raise exception 'the file has no entries'; end if;
    if p_slate_id is not null and not exists (select 1 from bsb.dfs_slates where id = p_slate_id) then p_slate_id := null; end if;
    if p_slate_id is null then
        -- which games was it? the recent slate that has the most of the file's players (a captain column means one game)
        select s.slate_id into p_slate_id
        from bsb.dfs_salaries s join bsb.dfs_slates sl on sl.id = s.slate_id
        where sl.starts_at between now() - interval '30 days' and now()
          and regexp_replace(lower(s.player_name), '[^a-z]', '', 'g') in (
              select regexp_replace(lower(x->>'name'), '[^a-z]', '', 'g') from jsonb_array_elements(p->'ownership') x)
        group by s.slate_id, sl.slate_type, sl.starts_at
        having count(distinct s.player_name) >= 6
        order by ((sl.slate_type = 'showdown') = exists (select 1 from jsonb_array_elements(p->'ownership') x where x->>'roster_position' = 'CPT')) desc,
                 count(distinct s.player_name) desc, sl.starts_at desc
        limit 1;
    end if;

    -- the fee and name, when the entries file for these games already told us about this contest
    select max(e.entry_fee), max(e.contest_name) into fee, nm from bsb.dk_entries e where e.contest_id = key;

    insert into bsb.contests (user_id, slate_id, contest_key, name, entry_fee, n_entries, scores)
    values (uid, p_slate_id, key, coalesce(nullif(trim(p->>'name'), ''), nm), coalesce((p->>'entry_fee')::numeric, fee),
            (p->>'n_entries')::int, p->'scores')
    on conflict (site, contest_key) do update
        set n_entries = excluded.n_entries, scores = excluded.scores, imported_at = now(),
            slate_id = coalesce(excluded.slate_id, bsb.contests.slate_id),
            name = coalesce(bsb.contests.name, excluded.name), entry_fee = coalesce(bsb.contests.entry_fee, excluded.entry_fee)
    returning id into cid;

    delete from bsb.contest_entries ce where ce.contest_id = cid
       and not exists (select 1 from jsonb_array_elements(p->'entries') x where x->>'entry_id' = ce.entry_id);
    insert into bsb.contest_entries (contest_id, entry_id, entry_name, rank, points, lineup)
    select cid, x->>'entry_id', left(x->>'entry_name', 80), (x->>'rank')::int, (x->>'points')::numeric, left(x->>'lineup', 600)
    from jsonb_array_elements(p->'entries') x where coalesce(x->>'entry_id', '') <> ''
    on conflict (contest_id, entry_id) do update
        set entry_name = excluded.entry_name, rank = excluded.rank, points = excluded.points, lineup = excluded.lineup;
    get diagnostics n_mine = row_count;

    delete from bsb.contest_ownership where contest_id = cid;
    insert into bsb.contest_ownership (contest_id, player_name, roster_position, player_id, pct_drafted, fpts)
    select distinct on (left(x->>'name', 80), coalesce(x->>'roster_position', ''))
           cid, left(x->>'name', 80), coalesce(x->>'roster_position', ''),
           (select s.player_id from bsb.dfs_salaries s
             where s.slate_id = p_slate_id and s.player_id is not null
               and regexp_replace(lower(s.player_name), '[^a-z]', '', 'g') = regexp_replace(lower(x->>'name'), '[^a-z]', '', 'g') limit 1),
           (x->>'pct_drafted')::numeric, (x->>'fpts')::numeric
    from jsonb_array_elements(p->'ownership') x where coalesce(x->>'name', '') <> ''
    order by 2, 3, 5 desc nulls last;
    get diagnostics n_own = row_count;

    return jsonb_build_object('contest_id', cid, 'entries', n_mine, 'players', n_own);
end $$;

-- What an entry won (null: not known yet), the contest's fee and name.
create or replace function public.bsb_set_contest_money(p_contest_id bigint, p_entry_fee numeric default null, p_name text default null,
                                                       p_winnings jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    if not exists (select 1 from bsb.contests where id = p_contest_id) then raise exception 'no such contest'; end if;
    if p_entry_fee is not null and (p_entry_fee < 0 or p_entry_fee > 100000) then raise exception 'entry fee out of range'; end if;
    update bsb.contests set entry_fee = coalesce(p_entry_fee, entry_fee), name = coalesce(nullif(trim(left(p_name, 120)), ''), name) where id = p_contest_id;
    if p_winnings is not null then
        if jsonb_typeof(p_winnings) <> 'object' then raise exception 'winnings must be given per entry'; end if;
        update bsb.contest_entries e set winnings = (w.value #>> '{}')::numeric
        from jsonb_each(p_winnings) w
        where e.contest_id = p_contest_id and e.entry_id = w.key
          and (w.value = 'null'::jsonb or (w.value #>> '{}')::numeric between 0 and 100000000);
    end if;
end $$;

create or replace function public.bsb_delete_contest(p_contest_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    delete from bsb.contests where id = p_contest_id;
end $$;

do $$
declare f text;
begin
    foreach f in array array['bsb_import_contest(bigint, jsonb)', 'bsb_set_contest_money(bigint, numeric, text, jsonb)', 'bsb_delete_contest(bigint)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;

-- ---------------------------------------------------------------------------
drop view if exists public.app_contests, public.app_contest_entries, public.app_contest_ownership;

create view public.app_contests with (security_invoker = true) as
select c.id, c.slate_id, sl.season, sl.week, sl.slate_type, c.contest_key, c.name, c.entry_fee, c.n_entries, c.scores, c.imported_at,
       m.n_mine, m.best_rank, m.best_points, m.won, m.n_unsettled,
       c.entry_fee * m.n_mine as paid,
       case when m.n_unsettled = 0 and c.entry_fee is not null then m.won - c.entry_fee * m.n_mine end as profit
from bsb.contests c
left join bsb.dfs_slates sl on sl.id = c.slate_id
left join lateral (
    select count(*) as n_mine, min(e.rank) as best_rank, max(e.points) as best_points,
           coalesce(sum(e.winnings), 0) as won, count(*) filter (where e.winnings is null) as n_unsettled
    from bsb.contest_entries e where e.contest_id = c.id) m on true;

create view public.app_contest_entries with (security_invoker = true) as
select e.contest_id, e.entry_id, e.entry_name, e.rank, e.points, e.lineup, e.winnings,
       d.set_id, d.lineup_no
from bsb.contest_entries e
left join bsb.dk_entries d on d.entry_id = e.entry_id;

create view public.app_contest_ownership with (security_invoker = true) as
select o.contest_id, o.player_name as name, o.roster_position, o.player_id, o.pct_drafted, o.fpts
from bsb.contest_ownership o;

do $$
declare v text;
begin
    foreach v in array array['app_contests', 'app_contest_entries', 'app_contest_ownership'] loop
        execute format('revoke all on public.%I from public, anon, authenticated', v);
        execute format('grant select on public.%I to authenticated', v);
    end loop;
end $$;
