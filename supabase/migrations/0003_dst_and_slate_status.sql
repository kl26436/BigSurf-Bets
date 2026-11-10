-- Big Surf Bets — DST projections + slate import timestamp
-- DST rows live in bsb.projections with position 'DST' and player_id 'DST_<team>'
-- (the same id bsb.dfs_salaries gets for DST rows on import).

begin;

alter table bsb.projections
    add column if not exists dst_sacks             numeric(6,3),
    add column if not exists dst_interceptions     numeric(6,3),
    add column if not exists dst_fumble_recoveries numeric(6,3),
    add column if not exists dst_tds               numeric(6,3),
    add column if not exists dst_points_allowed    numeric(6,2);

-- when a slate's salary file was last (re)imported: DK's Status column is only
-- trusted as an "inactive" signal while the import is fresh
alter table bsb.dfs_slates
    add column if not exists imported_at timestamptz not null default now();

-- the view was created with p.* before the new columns existed
drop view if exists bsb.projections_latest;
create view bsb.projections_latest as
select p.*, r.created_at as projected_at, r.model_version
from bsb.projections p
join bsb.model_runs r on r.id = p.run_id
where r.id = (
    select r2.id from bsb.model_runs r2
    where r2.sport = r.sport and r2.season = r.season and r2.week = r.week
    order by r2.created_at desc limit 1
);
grant select on bsb.projections_latest to anon, authenticated;

commit;
