-- Big Surf Bets — which lineups were played, DraftKings entries, and swapping a player (0012)
--
-- "Entered" was a flag on a whole set. A set of twenty is rarely entered whole:
-- two or three of its lineups are, and results can only become dollars when the
-- app knows which.
--
--   lineups.entered        this lineup was played (lineup_sets.entered = any of its lineups was)
--   lineups.edited_at      a player was swapped after the build (its simulated numbers no longer apply)
--   dk_entries             the rows of a DraftKings entries file: one per contest entry, with the
--                          lineup of ours it holds, so an edited file can be handed back
--   bsb_set_lineups_entered · bsb_replace_lineup · bsb_import_dk_entries · bsb_assign_entries
--
-- Nothing here removes existing rows.

begin;

alter table bsb.lineups add column if not exists entered   boolean not null default false;
alter table bsb.lineups add column if not exists edited_at timestamptz;
update bsb.lineups l set entered = true
  from bsb.lineup_sets s where s.id = l.set_id and s.entered and not l.entered;

drop view if exists public.app_lineups;
create view public.app_lineups with (security_invoker = true) as
select l.set_id, l.lineup_no, l.salary, l.proj, l.sim_mean, l.sim_std, l.p10, l.p50, l.p90, l.p99, l.best_of_set_pct,
       l.actual_points, l.entered, l.edited_at
from bsb.lineups l;

create table if not exists bsb.dk_entries (
    entry_id     text primary key,                 -- DraftKings' id for the entry
    slate_id     bigint not null references bsb.dfs_slates(id) on delete cascade,
    contest_id   text,
    contest_name text,
    entry_fee    numeric(10,2),
    players      text[],                           -- the nine DraftKings ids in the file when imported (null: an empty entry)
    set_id       bigint,                           -- the lineup of ours this entry holds
    lineup_no    int,
    imported_at  timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    user_id      uuid,
    foreign key (set_id, lineup_no) references bsb.lineups(set_id, lineup_no) on delete set null
);
create index if not exists dk_entries_slate_idx on bsb.dk_entries (slate_id);
alter table bsb.dk_entries enable row level security;
drop policy if exists members_read on bsb.dk_entries;
create policy members_read on bsb.dk_entries for select to authenticated using ((select bsb.is_member()));
grant select on bsb.dk_entries to authenticated;
grant all on bsb.dk_entries to service_role;

drop view if exists public.app_dk_entries;
create view public.app_dk_entries with (security_invoker = true) as
select e.entry_id, e.slate_id, e.contest_id, e.contest_name, e.entry_fee, e.players, e.set_id, e.lineup_no,
       e.imported_at, e.updated_at
from bsb.dk_entries e;

revoke all on public.app_lineups, public.app_dk_entries from public, anon, authenticated;
grant select on public.app_lineups, public.app_dk_entries to authenticated;

-- ---------------------------------------------------------------------------
-- entered, per lineup
-- ---------------------------------------------------------------------------
create or replace function bsb.sync_set_entered(p_set_id bigint) returns void
language sql security definer set search_path = '' as $$
    update bsb.lineup_sets s
       set entered = exists (select 1 from bsb.lineups l where l.set_id = s.id and l.entered)
     where s.id = p_set_id;
$$;
revoke all on function bsb.sync_set_entered(bigint) from public, anon, authenticated;

-- the whole set at once (what "Mark as entered" did before)
create or replace function public.bsb_set_entered(p_set_id bigint, p_entered boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    update bsb.lineups set entered = coalesce(p_entered, false) where set_id = p_set_id;
    perform bsb.sync_set_entered(p_set_id);
end $$;

-- some of its lineups → how many of the set are now entered
create or replace function public.bsb_set_lineups_entered(p_set_id bigint, p_lineup_nos int[], p_entered boolean) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
    perform bsb.require_member();
    if not exists (select 1 from bsb.lineup_sets where id = p_set_id) then raise exception 'no such lineup set'; end if;
    update bsb.lineups set entered = coalesce(p_entered, false)
     where set_id = p_set_id and lineup_no = any (coalesce(p_lineup_nos, '{}'::int[]));
    perform bsb.sync_set_entered(p_set_id);
    select count(*) into n from bsb.lineups where set_id = p_set_id and entered;
    return n;
end $$;

-- A lineup that was not played can be removed from a set even when others of the set were.
create or replace function public.bsb_delete_lineup(p_set_id bigint, p_lineup_no int) returns int
language plpgsql security definer set search_path = '' as $$
declare was_entered boolean; left_n int;
begin
    perform bsb.require_member();
    perform 1 from bsb.lineup_sets where id = p_set_id for update;
    if not found then raise exception 'no such lineup set'; end if;
    select entered into was_entered from bsb.lineups where set_id = p_set_id and lineup_no = p_lineup_no;
    if not found then raise exception 'no such lineup'; end if;
    if was_entered then
        raise exception 'this lineup is marked as entered: undo "entered" before removing it';
    end if;
    delete from bsb.lineups where set_id = p_set_id and lineup_no = p_lineup_no;
    select count(*) into left_n from bsb.lineups where set_id = p_set_id;
    if left_n = 0 then
        delete from bsb.lineup_sets where id = p_set_id;
        return 0;
    end if;
    update bsb.lineups set best_of_set_pct = null where set_id = p_set_id;
    update bsb.lineup_sets ls
       set n_lineups = left_n,
           summary = (coalesce(ls.summary, '{}'::jsonb) - 'set_best_mean' - 'set_best_p90' - 'best_lineup_mean' - 'max_exposure_pct')
                     || jsonb_build_object(
                            'n', left_n,
                            'avg_proj', (select round(avg(l.proj)::numeric, 2) from bsb.lineups l where l.set_id = p_set_id),
                            'players_used', (select count(distinct lp.site_player_id) from bsb.lineup_players lp where lp.set_id = p_set_id))
     where ls.id = p_set_id;
    return left_n;
end $$;

-- ---------------------------------------------------------------------------
-- swapping players in a stored lineup (a late scratch)
-- ---------------------------------------------------------------------------
-- Nine DraftKings ids in slot order must make a legal classic lineup. → its total salary.
create or replace function bsb.lineup_total(p_slate_id bigint, p_players text[]) returns int
language plpgsql stable security definer set search_path = '' as $$
declare
    slots text[] := array['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'];
    cap int; total int; n int; n_distinct int; n_games int; bad int;
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
    return total;
end $$;
revoke all on function bsb.lineup_total(bigint, text[]) from public, anon, authenticated;

-- Replace a lineup's nine players (slot order). Allowed on an entered lineup: that
-- is what a late swap is. A player whose game has started can be neither taken out
-- nor put in, which is DraftKings' own rule.
create or replace function public.bsb_replace_lineup(p_set_id bigint, p_lineup_no int, p_players text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
    slots text[] := array['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'];
    slate bigint; total int; locked text;
begin
    perform bsb.require_member();
    select slate_id into slate from bsb.lineup_sets where id = p_set_id for update;
    if not found then raise exception 'no such lineup set'; end if;
    if not exists (select 1 from bsb.lineups where set_id = p_set_id and lineup_no = p_lineup_no) then
        raise exception 'no such lineup';
    end if;
    total := bsb.lineup_total(slate, p_players);

    select string_agg(s.player_name, ', ') into locked
      from (select site_player_id from bsb.lineup_players where set_id = p_set_id and lineup_no = p_lineup_no
            except select unnest(p_players)
            union all
            (select unnest(p_players)
             except select site_player_id from bsb.lineup_players where set_id = p_set_id and lineup_no = p_lineup_no)) ch
      join bsb.dfs_salaries s on s.slate_id = slate and s.site_player_id = ch.site_player_id
      join bsb.games g on g.sport = 'nfl' and g.game_id = s.game_id
     where g.kickoff_at <= now();
    if locked is not null then raise exception 'the game has started for %', locked; end if;

    delete from bsb.lineup_players where set_id = p_set_id and lineup_no = p_lineup_no;
    insert into bsb.lineup_players (set_id, lineup_no, slot_no, slot, site_player_id, player_id, player_name, position, team, opponent, salary, dk_mean, status)
    select p_set_id, p_lineup_no, x.ord - 1, slots[x.ord], s.site_player_id, s.player_id, s.player_name, s.position, s.team, s.opponent,
           s.salary, coalesce(o.dk_mean, p.dk_mean), nullif(s.raw->>'Status', '')
    from unnest(p_players) with ordinality as x(dk_id, ord)
    join bsb.dfs_salaries s on s.slate_id = slate and s.site_player_id = x.dk_id
    join bsb.dfs_slates sl on sl.id = s.slate_id
    left join bsb.projections_latest p on p.player_id = s.player_id and p.season = sl.season and p.week = sl.week
    left join bsb.projection_overrides o on o.player_id = s.player_id and o.season = sl.season and o.week = sl.week;
    -- the simulation described the lineup as it was built
    update bsb.lineups l
       set salary = total,
           proj = (select round(sum(lp.dk_mean)::numeric, 2) from bsb.lineup_players lp where lp.set_id = p_set_id and lp.lineup_no = p_lineup_no),
           sim_mean = null, sim_std = null, p10 = null, p50 = null, p90 = null, p99 = null, best_of_set_pct = null,
           edited_at = now()
     where l.set_id = p_set_id and l.lineup_no = p_lineup_no;
    update bsb.lineup_sets ls
       set summary = (coalesce(ls.summary, '{}'::jsonb) - 'set_best_mean' - 'set_best_p90' - 'best_lineup_mean' - 'max_exposure_pct')
                     || jsonb_build_object(
                            'avg_proj', (select round(avg(l.proj)::numeric, 2) from bsb.lineups l where l.set_id = p_set_id),
                            'players_used', (select count(distinct lp.site_player_id) from bsb.lineup_players lp where lp.set_id = p_set_id))
     where ls.id = p_set_id;
end $$;

-- ---------------------------------------------------------------------------
-- DraftKings entries
-- ---------------------------------------------------------------------------
-- p_entries: [{entry_id, contest_id, contest_name, entry_fee, players: [nine ids] | null}], the rows of an
-- entries file for one slate. Entries of that slate missing from the file are dropped (withdrawn).
-- An entry holding exactly the players of one of our lineups is linked to it, and that lineup marked as entered.
create or replace function public.bsb_import_dk_entries(p_slate_id bigint, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := bsb.require_member(); n int; linked int; r record;
begin
    if not exists (select 1 from bsb.dfs_slates where id = p_slate_id) then raise exception 'unknown slate'; end if;
    if jsonb_typeof(p_entries) <> 'array' then raise exception 'entries must be a list'; end if;
    n := jsonb_array_length(p_entries);
    if n = 0 or n > 500 then raise exception 'an entries file has between 1 and 500 entries'; end if;
    if exists (select 1 from jsonb_array_elements(p_entries) e where coalesce(e->>'entry_id', '') = '') then
        raise exception 'every entry needs an entry id';
    end if;

    insert into bsb.dk_entries (entry_id, slate_id, contest_id, contest_name, entry_fee, players, user_id)
    select e->>'entry_id', p_slate_id, nullif(e->>'contest_id', ''), nullif(left(e->>'contest_name', 200), ''),
           nullif(e->>'entry_fee', '')::numeric,
           case when jsonb_typeof(e->'players') = 'array' and jsonb_array_length(e->'players') = 9
                then array(select jsonb_array_elements_text(e->'players')) end,
           uid
    from jsonb_array_elements(p_entries) e
    on conflict (entry_id) do update
       set slate_id = excluded.slate_id, contest_id = excluded.contest_id, contest_name = excluded.contest_name,
           entry_fee = excluded.entry_fee, players = excluded.players, updated_at = now();
    delete from bsb.dk_entries d
     where d.slate_id = p_slate_id
       and not exists (select 1 from jsonb_array_elements(p_entries) e where e->>'entry_id' = d.entry_id);

    for r in
        select d.entry_id, m.set_id, m.lineup_no
        from bsb.dk_entries d
        cross join lateral (
            select l.set_id, l.lineup_no
            from bsb.lineups l join bsb.lineup_sets ls on ls.id = l.set_id
            where ls.slate_id = p_slate_id and ls.archived_at is null
              and (select array_agg(lp.site_player_id order by lp.site_player_id) from bsb.lineup_players lp
                   where lp.set_id = l.set_id and lp.lineup_no = l.lineup_no)
                  = (select array_agg(x order by x) from unnest(d.players) x)
            order by l.entered desc, ls.created_at desc, l.lineup_no limit 1) m
        where d.slate_id = p_slate_id and d.set_id is null and d.players is not null
    loop
        update bsb.dk_entries set set_id = r.set_id, lineup_no = r.lineup_no where entry_id = r.entry_id;
        update bsb.lineups set entered = true where set_id = r.set_id and lineup_no = r.lineup_no;
        perform bsb.sync_set_entered(r.set_id);
    end loop;
    select count(*) filter (where set_id is not null) into linked from bsb.dk_entries where slate_id = p_slate_id;
    return jsonb_build_object('entries', n, 'linked', linked);
end $$;

-- p_assignments: [{entry_id, set_id, lineup_no}] (set_id null: take the lineup off the entry).
-- A lineup put on an entry is marked as entered.
create or replace function public.bsb_assign_entries(p_assignments jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare a jsonb; sid bigint; lno int; done int := 0;
begin
    perform bsb.require_member();
    if jsonb_typeof(p_assignments) <> 'array' then raise exception 'assignments must be a list'; end if;
    for a in select * from jsonb_array_elements(p_assignments) loop
        sid := nullif(a->>'set_id', '')::bigint;
        lno := nullif(a->>'lineup_no', '')::int;
        if sid is not null and not exists (
            select 1 from bsb.lineups l join bsb.lineup_sets ls on ls.id = l.set_id
            join bsb.dk_entries d on d.entry_id = a->>'entry_id' and d.slate_id = ls.slate_id
            where l.set_id = sid and l.lineup_no = lno) then
            raise exception 'that lineup is not from the same games as the entry';
        end if;
        update bsb.dk_entries set set_id = sid, lineup_no = case when sid is null then null else lno end, updated_at = now()
         where entry_id = a->>'entry_id';
        if found then done := done + 1; end if;
        if sid is not null then
            update bsb.lineups set entered = true where set_id = sid and lineup_no = lno;
            perform bsb.sync_set_entered(sid);
        end if;
    end loop;
    return done;
end $$;

do $$
declare f text;
begin
    foreach f in array array['bsb_set_entered(bigint, boolean)', 'bsb_set_lineups_entered(bigint, int[], boolean)',
        'bsb_delete_lineup(bigint, int)', 'bsb_replace_lineup(bigint, int, text[])',
        'bsb_import_dk_entries(bigint, jsonb)', 'bsb_assign_entries(jsonb)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;

commit;
