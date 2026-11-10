-- Big Surf Bets — market edges (props + game lines) and weekly scorecards

begin;

-- odds_latest collapsed every player's prop (and every alternate line) into one
-- row, because neither the player nor the line was part of its key.
create or replace view bsb.odds_latest as
select distinct on (sport, game_id, bookmaker, market, period, player_id, (raw->>'playerName'), prop_type, outcome, line)
    *
from bsb.odds_snapshots
order by sport, game_id, bookmaker, market, period, player_id, (raw->>'playerName'), prop_type, outcome, line, captured_at desc;

-- Player props, canonical and priced. One row per projection run × player × stat × line × book.
create table if not exists bsb.prop_prices (
    run_id        bigint not null references bsb.model_runs(id) on delete cascade,
    season        int    not null,
    week          int    not null,
    game_id       text   not null,
    player_id     text   not null,
    team          text,
    stat          text   not null,              -- our stat name, or anytime_td
    line          numeric(6,1) not null,        -- over = strictly more than this
    bookmaker     text   not null,
    over_decimal  numeric(8,3),
    under_decimal numeric(8,3),
    hold          numeric(6,4),                 -- vig of the two-way market (null if one-sided)
    novig_over    numeric(6,4),                 -- book's own fair P(over), if two-way and coherent
    proj_mean     numeric(7,2),                 -- model projection for the stat
    model_over    numeric(6,4),                 -- model P(over line)
    captured_at   timestamptz,                  -- when the price was seen
    actual        numeric(7,2),                 -- filled in by the scorecard after the game
    primary key (run_id, player_id, stat, line, bookmaker)
);
create index if not exists prop_prices_week_idx on bsb.prop_prices (season, week, player_id, stat);

-- Newest pricing per week, with fair value from Pinnacle at the same line and the EV of
-- each side at this book under (a) Pinnacle's no-vig probability and (b) our model.
drop view if exists bsb.prop_edges;
create view bsb.prop_edges as
with latest as (
    select p.* from bsb.prop_prices p
    where p.run_id = (select max(p2.run_id) from bsb.prop_prices p2 where p2.season = p.season and p2.week = p.week)
)
select l.season, l.week, l.game_id, l.player_id, pl.display_name as player_name, l.team, l.stat, l.line, l.bookmaker,
       l.over_decimal, l.under_decimal, l.hold, l.proj_mean, l.model_over,
       s.novig_over                                          as fair_over,          -- Pinnacle, same line
       round(s.novig_over * l.over_decimal - 1, 4)           as ev_over_fair,
       round((1 - s.novig_over) * l.under_decimal - 1, 4)    as ev_under_fair,
       round(l.model_over * l.over_decimal - 1, 4)           as ev_over_model,
       round((1 - l.model_over) * l.under_decimal - 1, 4)    as ev_under_model,
       l.captured_at, l.run_id
from latest l
left join latest s on s.bookmaker = 'pinnacle' and s.player_id = l.player_id and s.stat = l.stat
                  and s.line = l.line and s.novig_over is not null
left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = l.player_id;

-- Game lines across books, one row per quote per analysed snapshot.
create table if not exists bsb.line_quotes (
    captured_at    timestamptz not null,
    game_id        text not null,
    season         int, week int,
    market         text not null,               -- moneyline / spread / total
    number         numeric(5,1) not null,       -- home spread or total; 0 for moneyline
    outcome        text not null,               -- home / away / over / under
    line           numeric(5,1),                -- the number as quoted for this side
    bookmaker      text not null,
    price_american int,
    price_decimal  numeric(8,3) not null,
    hold           numeric(6,4),                -- this book's vig on the market
    fair_prob      numeric(6,4),                -- Pinnacle no-vig probability of this outcome
    ev             numeric(7,4),                -- fair_prob × price − 1
    is_best        boolean,                     -- best price for this outcome across books
    arb_pct        numeric(7,4),                -- return from backing both sides at the best prices
    primary key (captured_at, game_id, market, number, outcome, bookmaker)
);
create index if not exists line_quotes_game_idx on bsb.line_quotes (game_id, captured_at desc);

create or replace view bsb.line_quotes_latest as
select * from bsb.line_quotes where captured_at = (select max(captured_at) from bsb.line_quotes);

-- Weekly scorecard: how last week's projections, lineups and prop prices did.
create table if not exists bsb.scorecards (
    sport      text not null default 'nfl',
    season     int  not null,
    week       int  not null,
    created_at timestamptz not null default now(),
    metrics    jsonb not null,
    primary key (sport, season, week)
);

create table if not exists bsb.player_results (
    sport     text not null default 'nfl',
    season    int  not null,
    week      int  not null,
    player_id text not null,                    -- incl. DST_<team>
    position  text,
    team      text,
    dk        numeric(6,2),
    ppr       numeric(6,2),
    primary key (sport, season, week, player_id)
);

alter table bsb.lineups add column if not exists actual_points numeric(6,2);

grant select on bsb.prop_prices, bsb.prop_edges, bsb.line_quotes, bsb.line_quotes_latest,
                bsb.scorecards, bsb.player_results to anon, authenticated;
grant all on bsb.prop_prices, bsb.line_quotes, bsb.scorecards, bsb.player_results to service_role;

commit;
