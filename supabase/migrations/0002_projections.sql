-- Big Surf Bets — Phase 2: model runs + player-week projections
-- Append-only: every `bsb model project` adds a run. The app reads
-- bsb.projections_latest (newest run per sport/season/week).

begin;

create table if not exists bsb.model_runs (
    id              bigserial primary key,
    sport           text        not null default 'nfl',
    created_at      timestamptz not null default now(),
    model_version   text        not null,
    season          int         not null,           -- week being projected
    week            int         not null,
    trained_seasons int[]       not null,
    n_train_rows    int,
    n_features      int,
    n_players       int,
    n_ruled_out     int,                            -- players excluded via Sleeper statuses
    metrics         jsonb,                          -- out-of-fold MAE per stat
    git_sha         text
);
create index if not exists model_runs_week_idx on bsb.model_runs (sport, season, week, created_at desc);

create table if not exists bsb.projections (
    run_id          bigint  not null references bsb.model_runs(id) on delete cascade,
    sport           text    not null default 'nfl',
    season          int     not null,
    week            int     not null,
    player_id       text    not null,
    game_id         text,
    team            text,
    opponent        text,
    position        text,
    injury_status   text,                           -- Questionable / Doubtful on the official report
    -- projected means; names match bsb.player_week_stats so actual-vs-projected is a plain join
    attempts        numeric(7,3), completions numeric(7,3), passing_yards numeric(7,3),
    passing_tds     numeric(7,3), interceptions numeric(7,3),
    carries         numeric(7,3), rushing_yards numeric(7,3), rushing_tds numeric(7,3),
    targets         numeric(7,3), receptions numeric(7,3), receiving_yards numeric(7,3),
    receiving_tds   numeric(7,3),
    -- fantasy points: mean, spread and quantiles of the outcome distribution
    dk_mean  numeric(6,2), dk_std  numeric(6,2),
    dk_p10   numeric(6,2), dk_p25  numeric(6,2), dk_p50  numeric(6,2), dk_p75  numeric(6,2), dk_p90  numeric(6,2),
    ppr_mean numeric(6,2), ppr_std numeric(6,2),
    ppr_p10  numeric(6,2), ppr_p25 numeric(6,2), ppr_p50 numeric(6,2), ppr_p75 numeric(6,2), ppr_p90 numeric(6,2),
    anytime_td_prob numeric(5,4),
    stat_quantiles  jsonb,                          -- {stat: {p10,p25,p50,p75,p90}} for prop stats
    primary key (run_id, player_id)
);
create index if not exists projections_week_idx   on bsb.projections (sport, season, week, player_id);
create index if not exists projections_player_idx on bsb.projections (sport, player_id, season, week);

create or replace view bsb.projections_latest as
select p.*, r.created_at as projected_at, r.model_version
from bsb.projections p
join bsb.model_runs r on r.id = p.run_id
where r.id = (
    select r2.id from bsb.model_runs r2
    where r2.sport = r.sport and r2.season = r.season and r2.week = r.week
    order by r2.created_at desc limit 1
);

grant select on bsb.model_runs, bsb.projections, bsb.projections_latest to anon, authenticated;
grant all on bsb.model_runs, bsb.projections to service_role;
grant all on all sequences in schema bsb to service_role;

commit;
