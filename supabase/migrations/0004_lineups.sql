-- Big Surf Bets — Phase 3: optimizer output
-- A lineup set = one optimizer run for one slate (e.g. "20 tournament lineups").
-- Append-only; the app shows the newest set per slate and mode.

begin;

create table if not exists bsb.lineup_sets (
    id          bigserial primary key,
    created_at  timestamptz not null default now(),
    slate_id    bigint not null references bsb.dfs_slates(id) on delete cascade,
    run_id      bigint references bsb.model_runs(id) on delete set null,  -- projections used
    mode        text   not null,                 -- gpp / cash
    n_lineups   int    not null,
    settings    jsonb,                           -- exposure cap, min unique, rules, sims …
    summary     jsonb                            -- set-level sim stats
);
create index if not exists lineup_sets_slate_idx on bsb.lineup_sets (slate_id, mode, created_at desc);

create table if not exists bsb.lineups (
    set_id     bigint not null references bsb.lineup_sets(id) on delete cascade,
    lineup_no  int    not null,
    salary     int    not null,
    proj       numeric(6,2),                     -- sum of projected means
    sim_mean   numeric(6,2), sim_std numeric(6,2),
    p10 numeric(6,1), p50 numeric(6,1), p90 numeric(6,1), p99 numeric(6,1),
    best_of_set_pct numeric(5,1),                -- share of simulations where this is the set's top lineup
    primary key (set_id, lineup_no)
);

create table if not exists bsb.lineup_players (
    set_id         bigint not null,
    lineup_no      int    not null,
    slot_no        int    not null,              -- 0..8 in DK slot order
    slot           text   not null,              -- QB RB RB WR WR WR TE FLEX DST
    site_player_id text   not null,
    player_id      text,
    player_name    text   not null,
    position       text   not null,
    team           text,
    opponent       text,
    salary         int    not null,
    dk_mean        numeric(6,2),
    status         text,                         -- DK status at build time (Q …)
    primary key (set_id, lineup_no, slot_no),
    foreign key (set_id, lineup_no) references bsb.lineups(set_id, lineup_no) on delete cascade
);
create index if not exists lineup_players_player_idx on bsb.lineup_players (set_id, site_player_id);

grant select on bsb.lineup_sets, bsb.lineups, bsb.lineup_players to anon, authenticated;
grant all on bsb.lineup_sets, bsb.lineups, bsb.lineup_players to service_role;
grant all on all sequences in schema bsb to service_role;

commit;
