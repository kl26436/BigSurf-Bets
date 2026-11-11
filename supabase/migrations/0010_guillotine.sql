-- 0010: guillotine ("chop") league — waiver bid history and the weekly bid advice.
--
-- fantasy_transactions  every Sleeper transaction of the league (adds, drops, chops and
--                       every blind waiver bid, won or lost). One row per transaction;
--                       refreshed from the API (they do not change once processed).
-- waiver_runs / _recs   the bid advice, append-only; the app shows the latest run.

create table if not exists bsb.fantasy_transactions (
    transaction_id text primary key,
    league_id      text not null references bsb.fantasy_leagues(league_id),
    leg            int,                       -- Sleeper week the transaction belongs to
    type           text not null,             -- waiver | free_agent | chopped | trade | commissioner
    status         text,                      -- complete | failed
    roster_id      int,                       -- the roster that asked
    player_id      text,                      -- Sleeper id of the player added (waiver / free agent)
    drop_player_id text,
    bid            numeric(8,2),              -- waiver bid
    adds           jsonb,
    drops          jsonb,
    created        timestamptz,
    status_updated timestamptz,
    note           text
);
create index if not exists fantasy_tx_league_idx on bsb.fantasy_transactions (league_id, type, status_updated);

create table if not exists bsb.waiver_runs (
    id           bigserial primary key,
    league_id    text not null,
    created_at   timestamptz not null default now(),
    week         int not null,
    teams_left   int not null,
    budget       numeric(8,2),               -- mine
    chop         double precision,           -- my chance of being chopped this week, as the roster stands
    win          double precision,           -- my chance of winning the league
    dollar_value double precision,           -- lineup points a dollar kept is expected to buy later
    teams        jsonb not null,             -- [{owner, is_me, budget, mean, chop, win}]
    drops        jsonb                       -- my least valuable players
);

create table if not exists bsb.waiver_recs (
    run_id     bigint not null references bsb.waiver_runs(id) on delete cascade,
    rank       int not null,
    sleeper_id text not null,
    name       text not null,
    pos        text,
    team       text,
    status     text,
    proj       double precision,             -- this week's expected points
    level      double precision,             -- points a week when he plays
    gain_now   double precision,             -- added to my lineup this week
    gain_avg   double precision,             -- … per week, rest of season
    d_chop     double precision,             -- change in my chance of being chopped this week
    d_win      double precision,             -- change in my chance of winning the league
    bid_50     int, bid_80 int, bid_95 int,  -- bids that beat every rival in 50 / 80 / 95% of simulations
    bid        int not null default 0,       -- suggested bid (0 = none)
    win_at_bid double precision,
    either_or  text,                         -- bids sharing a letter share a drop: at most one should win
    drop_name  text,
    rivals     jsonb,                        -- [{owner, bid}] likeliest rival bids
    can_outbid text[],                       -- rivals with more money than the suggested bid
    primary key (run_id, rank)
);

do $$
declare t text;
begin
    foreach t in array array['fantasy_transactions', 'waiver_runs', 'waiver_recs'] loop
        execute format('alter table bsb.%I enable row level security', t);
        execute format('drop policy if exists members_read on bsb.%I', t);
        execute format('create policy members_read on bsb.%I for select to authenticated using ((select bsb.is_member()))', t);
        execute format('grant select on bsb.%I to authenticated', t);
    end loop;
end $$;

drop view if exists public.app_waiver_recs, public.app_waiver_run;

create view public.app_waiver_run with (security_invoker = true) as
select r.id, r.league_id, r.created_at, r.week, r.teams_left, r.budget, r.chop, r.win, r.teams, r.drops
from bsb.waiver_runs r order by r.created_at desc limit 1;

create view public.app_waiver_recs with (security_invoker = true) as
select c.run_id, c.rank, c.sleeper_id, c.name, c.pos, c.team, c.status, c.proj, c.level, c.gain_now, c.gain_avg,
       c.d_chop, c.d_win, c.bid_50, c.bid_80, c.bid_95, c.bid, c.win_at_bid, c.either_or, c.drop_name, c.rivals,
       c.can_outbid
from bsb.waiver_recs c where c.run_id = (select max(id) from bsb.waiver_runs);

revoke all on public.app_waiver_run, public.app_waiver_recs from public, anon, authenticated;
grant select on public.app_waiver_run, public.app_waiver_recs to authenticated;
