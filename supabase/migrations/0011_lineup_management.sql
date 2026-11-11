-- Big Surf Bets — managing lineup sets from the app (0011)
--
-- Until now a lineup set could be marked as entered and nothing else: it had a
-- name column the app never filled, there was no way to remove a set or one of
-- its lineups, and a build request that failed stayed on the Lineups screen.
--
--   lineup_sets.archived_at   hidden from the Lineups screen, kept for results
--   app_jobs.dismissed_at     a request the user has waved away
--   bsb_rename_set · bsb_delete_set · bsb_archive_set · bsb_delete_lineup · bsb_dismiss_job
--
-- A set marked as entered is the record of what was played, so it cannot be
-- deleted or changed: un-mark it first, or archive it.
--
-- Nothing here removes existing rows. Superseded automatic sets stay in the
-- table; the app and the scorecard now look only at the newest one per kind.

begin;

alter table bsb.lineup_sets add column if not exists archived_at  timestamptz;
alter table bsb.app_jobs    add column if not exists dismissed_at timestamptz;

-- views gain a column: drop and create (a replaced view may only append, and
-- being explicit keeps the grants below in one place)
drop view if exists public.app_lineup_sets;
create view public.app_lineup_sets with (security_invoker = true) as
select ls.id, ls.created_at, ls.slate_id, ls.run_id, ls.mode, ls.source, ls.entered, ls.label, ls.job_id, ls.n_lineups,
       ls.settings, ls.summary,
       ls.run_id is not distinct from (
           select r.id from bsb.model_runs r join bsb.dfs_slates sl on sl.id = ls.slate_id
           where r.season = sl.season and r.week = sl.week order by r.created_at desc limit 1) as on_latest_projections,
       ls.archived_at
from bsb.lineup_sets ls;

drop view if exists public.app_jobs;
create view public.app_jobs with (security_invoker = true) as
select j.id, j.created_at, j.kind, j.payload - 'csv' as payload, j.status, j.started_at, j.finished_at, j.result, j.error,
       j.dismissed_at
from bsb.app_jobs j;

revoke all on public.app_lineup_sets, public.app_jobs from public, anon, authenticated;
grant select on public.app_lineup_sets, public.app_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- writes (each checks membership, like the rest of public.bsb_*)
-- ---------------------------------------------------------------------------
create or replace function public.bsb_rename_set(p_set_id bigint, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare
    name text := nullif(left(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')), 60), '');
begin
    perform bsb.require_member();
    update bsb.lineup_sets set label = name where id = p_set_id;
    if not found then raise exception 'no such lineup set'; end if;
end $$;

create or replace function public.bsb_archive_set(p_set_id bigint, p_archived boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    update bsb.lineup_sets
       set archived_at = case when coalesce(p_archived, true) then coalesce(archived_at, now()) end
     where id = p_set_id;
    if not found then raise exception 'no such lineup set'; end if;
end $$;

create or replace function public.bsb_delete_set(p_set_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare was_entered boolean;
begin
    perform bsb.require_member();
    select entered into was_entered from bsb.lineup_sets where id = p_set_id for update;
    if not found then raise exception 'no such lineup set'; end if;
    if was_entered then
        raise exception 'this set is marked as entered: archive it, or undo "entered" first';
    end if;
    delete from bsb.lineup_sets where id = p_set_id;      -- lineups and their players go with it
end $$;

-- Remove one lineup from a set. → lineups left (0 = the set went with its last lineup).
-- The set's simulation numbers described all of its lineups together, so the
-- ones that no longer hold are cleared rather than left stale.
create or replace function public.bsb_delete_lineup(p_set_id bigint, p_lineup_no int) returns int
language plpgsql security definer set search_path = '' as $$
declare was_entered boolean; left_n int;
begin
    perform bsb.require_member();
    select entered into was_entered from bsb.lineup_sets where id = p_set_id for update;
    if not found then raise exception 'no such lineup set'; end if;
    if was_entered then
        raise exception 'this set is marked as entered: undo "entered" before changing it';
    end if;
    delete from bsb.lineups where set_id = p_set_id and lineup_no = p_lineup_no;
    if not found then raise exception 'no such lineup'; end if;
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

create or replace function public.bsb_dismiss_job(p_job_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    update bsb.app_jobs set dismissed_at = coalesce(dismissed_at, now()) where id = p_job_id;
end $$;

do $$
declare f text;
begin
    foreach f in array array['bsb_rename_set(bigint, text)', 'bsb_archive_set(bigint, boolean)', 'bsb_delete_set(bigint)',
        'bsb_delete_lineup(bigint, int)', 'bsb_dismiss_job(bigint)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;

commit;
