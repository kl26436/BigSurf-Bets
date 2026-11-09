-- Big Surf Bets — core schema (Phase 1: data ingestion)
-- Sport-agnostic where cheap; NFL-specific detail lives in JSONB `raw` columns
-- with the DFS-relevant fields promoted to real columns for fast querying.
--
-- Apply with:  psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_core.sql
-- or           bsb db migrate

begin;

create schema if not exists bsb;
comment on schema bsb is 'Big Surf Bets application schema';

-- ---------------------------------------------------------------------------
-- Reference
-- ---------------------------------------------------------------------------

create table if not exists bsb.teams (
    sport        text        not null default 'nfl',
    team_abbr    text        not null,
    team_name    text        not null,
    team_nick    text,
    conference   text,
    division     text,
    color_primary text,
    color_secondary text,
    logo_url     text,
    raw          jsonb,
    updated_at   timestamptz not null default now(),
    primary key (sport, team_abbr)
);

create table if not exists bsb.players (
    sport          text        not null default 'nfl',
    player_id      text        not null,          -- nflverse gsis_id
    display_name   text        not null,
    first_name     text,
    last_name      text,
    position       text,
    position_group text,
    latest_team    text,
    status         text,                          -- ACT / RES / CUT ...
    birth_date     date,
    height_in      int,
    weight_lb      int,
    rookie_season  int,
    headshot_url   text,
    espn_id        text,
    pfr_id         text,
    sleeper_id     text,                          -- filled by sleeper ingest
    raw            jsonb,
    updated_at     timestamptz not null default now(),
    primary key (sport, player_id)
);
create index if not exists players_name_idx on bsb.players using gin (to_tsvector('simple', display_name));
create index if not exists players_team_idx on bsb.players (sport, latest_team);

-- ---------------------------------------------------------------------------
-- Schedule / games
-- ---------------------------------------------------------------------------

create table if not exists bsb.games (
    sport        text        not null default 'nfl',
    game_id      text        not null,            -- nflverse game_id e.g. 2026_09_DAL_PHI
    season       int         not null,
    week         int         not null,
    game_type    text        not null,            -- REG / WC / DIV / CON / SB
    kickoff_at   timestamptz,                     -- gameday + gametime, US/Eastern → UTC
    home_team    text        not null,
    away_team    text        not null,
    home_score   int,
    away_score   int,
    roof         text,
    surface      text,
    temp_f       int,
    wind_mph     int,
    -- closing consensus lines from nflverse (useful for backtests; NOT live odds)
    spread_line  numeric(5,1),
    total_line   numeric(5,1),
    home_moneyline int,
    away_moneyline int,
    espn_id      text,
    raw          jsonb,
    updated_at   timestamptz not null default now(),
    primary key (sport, game_id)
);
create index if not exists games_season_week_idx on bsb.games (sport, season, week);
create index if not exists games_kickoff_idx on bsb.games (kickoff_at);

-- ---------------------------------------------------------------------------
-- Player weekly stats (the modeling backbone)
-- ---------------------------------------------------------------------------

create table if not exists bsb.player_week_stats (
    sport          text    not null default 'nfl',
    season         int     not null,
    week           int     not null,
    season_type    text    not null,              -- REG / POST
    player_id      text    not null,
    game_id        text,
    team           text,
    opponent       text,
    position       text,
    -- promoted DFS-relevant fields
    completions    int, attempts int, passing_yards int, passing_tds int, interceptions int,
    carries        int, rushing_yards int, rushing_tds int,
    targets        int, receptions int, receiving_yards int, receiving_tds int,
    fumbles_lost   int,
    target_share   numeric(6,4),
    air_yards_share numeric(6,4),
    wopr           numeric(6,4),
    passing_epa    numeric(8,3),
    rushing_epa    numeric(8,3),
    receiving_epa  numeric(8,3),
    fantasy_points_ppr numeric(6,2),
    fantasy_points_dk  numeric(6,2),              -- computed by ingest (DK scoring)
    raw            jsonb,                         -- all 150 nflverse columns
    updated_at     timestamptz not null default now(),
    primary key (sport, season, week, season_type, player_id)
);
create index if not exists pws_player_idx on bsb.player_week_stats (sport, player_id, season, week);
create index if not exists pws_game_idx   on bsb.player_week_stats (sport, game_id);
create index if not exists pws_opp_idx    on bsb.player_week_stats (sport, season, opponent, position);

-- ---------------------------------------------------------------------------
-- Injuries — two sources, kept separate so we can see disagreement
-- ---------------------------------------------------------------------------

-- Official weekly injury reports (nflverse; Wed/Thu/Fri practice + game status)
create table if not exists bsb.injury_reports (
    sport            text not null default 'nfl',
    season           int  not null,
    week             int  not null,
    player_id        text not null,
    team             text,
    position         text,
    report_status    text,                        -- Out / Doubtful / Questionable / null
    report_injury    text,
    practice_status  text,                        -- DNP / Limited / Full
    practice_injury  text,
    raw              jsonb,
    updated_at       timestamptz not null default now(),
    primary key (sport, season, week, player_id)
);

-- Point-in-time status snapshots (Sleeper; polled day-of). Append-only.
create table if not exists bsb.player_status_snapshots (
    id               bigserial primary key,
    sport            text not null default 'nfl',
    source           text not null default 'sleeper',
    captured_at      timestamptz not null default now(),
    player_id        text,                        -- our id when mapped
    source_player_id text not null,
    team             text,
    position         text,
    injury_status    text,                        -- Out / Doubtful / Questionable / IR / PUP ...
    injury_body_part text,
    injury_notes     text,
    depth_chart_order int,
    raw              jsonb
);
create index if not exists pss_captured_idx on bsb.player_status_snapshots (captured_at desc);
create index if not exists pss_player_idx   on bsb.player_status_snapshots (sport, player_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Odds — append-only snapshots so we can compute line movement + CLV later
-- ---------------------------------------------------------------------------

create table if not exists bsb.bookmakers (
    slug         text primary key,                -- provider-agnostic canonical slug
    display_name text not null,
    is_sharp     boolean not null default false,  -- pinnacle, circa → true
    region       text,                            -- us / global / offshore
    notes        text
);
insert into bsb.bookmakers (slug, display_name, is_sharp, region) values
    ('pinnacle',   'Pinnacle',   true,  'global'),
    ('circa',      'Circa Sports', true, 'us'),
    ('draftkings', 'DraftKings', false, 'us'),
    ('betmgm',     'BetMGM',     false, 'us'),
    ('fanduel',    'FanDuel',    false, 'us'),
    ('caesars',    'Caesars',    false, 'us')
on conflict (slug) do nothing;

create table if not exists bsb.odds_snapshots (
    id            bigserial primary key,
    sport         text        not null default 'nfl',
    captured_at   timestamptz not null default now(),
    provider      text        not null,           -- oddspapi / oddslink / nflverse_closing
    provider_fixture_id text,
    game_id       text,                           -- our id, when mapped
    bookmaker     text        not null references bsb.bookmakers(slug),
    market        text        not null,           -- moneyline / spread / total / player_prop
    period        text        not null default 'full',   -- full / 1h / 2h / 1q ...
    player_id     text,                           -- for props
    prop_type     text,                           -- passing_yards / anytime_td / receptions ...
    outcome       text        not null,           -- home / away / over / under / yes / no
    line          numeric(7,2),                   -- spread / total / prop line; null for ML
    price_decimal numeric(8,4) not null,
    price_american int,
    is_live       boolean     not null default false,
    raw           jsonb
);
create index if not exists odds_game_idx     on bsb.odds_snapshots (sport, game_id, market, captured_at desc);
create index if not exists odds_player_idx   on bsb.odds_snapshots (sport, player_id, prop_type, captured_at desc);
create index if not exists odds_captured_idx on bsb.odds_snapshots (captured_at desc);

-- Latest line per (game, book, market, outcome) — convenience view for the app
create or replace view bsb.odds_latest as
select distinct on (sport, game_id, bookmaker, market, period, player_id, prop_type, outcome)
    *
from bsb.odds_snapshots
order by sport, game_id, bookmaker, market, period, player_id, prop_type, outcome, captured_at desc;

-- ---------------------------------------------------------------------------
-- DFS: slates and salaries
-- ---------------------------------------------------------------------------

create table if not exists bsb.dfs_slates (
    id            bigserial primary key,
    sport         text not null default 'nfl',
    site          text not null default 'draftkings',
    slate_type    text not null,                  -- classic / showdown
    slate_name    text,
    site_slate_id text,                           -- DK draftGroupId
    season        int,
    week          int,
    starts_at     timestamptz,
    salary_cap    int not null default 50000,
    roster_json   jsonb,                          -- position slots
    created_at    timestamptz not null default now(),
    unique (site, site_slate_id)
);

create table if not exists bsb.dfs_salaries (
    slate_id      bigint not null references bsb.dfs_slates(id) on delete cascade,
    site_player_id text not null,
    player_id     text,                           -- our id, when mapped
    player_name   text not null,
    team          text,
    opponent      text,
    position      text not null,
    roster_positions text[],                      -- e.g. {RB, FLEX} or {CPT, FLEX}
    salary        int  not null,
    avg_points    numeric(6,2),                   -- site-provided AvgPointsPerGame
    game_id       text,
    raw           jsonb,
    primary key (slate_id, site_player_id)
);
create index if not exists dfs_salaries_player_idx on bsb.dfs_salaries (player_id);

-- ---------------------------------------------------------------------------
-- Ops: ingestion runs
-- ---------------------------------------------------------------------------

create table if not exists bsb.ingest_runs (
    id          bigserial primary key,
    job         text not null,                    -- nflverse.player_stats, sleeper.status, odds.oddspapi ...
    started_at  timestamptz not null default now(),
    finished_at timestamptz,
    ok          boolean,
    rows_written int,
    detail      jsonb
);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function bsb.touch_updated_at() returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end $$;

do $$
declare t text;
begin
    foreach t in array array['teams','players','games','player_week_stats','injury_reports'] loop
        execute format('drop trigger if exists touch_updated_at on bsb.%I', t);
        execute format('create trigger touch_updated_at before update on bsb.%I
                        for each row execute function bsb.touch_updated_at()', t);
    end loop;
end $$;

-- Expose schema to PostgREST so the PWA can read via supabase-js later.
grant usage on schema bsb to anon, authenticated, service_role;
grant select on all tables in schema bsb to anon, authenticated;
grant all on all tables in schema bsb to service_role;
grant all on all sequences in schema bsb to service_role;
alter default privileges in schema bsb grant select on tables to anon, authenticated;
alter default privileges in schema bsb grant all on tables to service_role;

commit;
