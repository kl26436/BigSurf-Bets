-- Big Surf Bets — a record of the bets placed.
--
-- The app already says which prices are worth taking; nothing kept what was actually
-- bet, so there was no way to tell whether following it makes money. A bet is written
-- down when it is placed (the price taken, the stake, the true chance at the time),
-- graded from the final score, and compared with the closing price: beating the close
-- is the earliest honest sign of an edge, long before the win/loss record means anything.
--
-- Adds a table, a view and five functions. Changes and deletes nothing that exists.

begin;

create table if not exists bsb.bets (
    id            bigint generated always as identity primary key,
    created_at    timestamptz not null default now(),
    user_id       uuid default auth.uid(),
    placed_at     timestamptz not null default now(),
    bookmaker     text not null,
    kind          text not null check (kind in ('game', 'player', 'other')),
    description   text not null check (length(description) between 1 and 200),
    game_id       text,
    market        text,                         -- moneyline / spread / total, or the stat of a player bet
    number        numeric(6,1),                 -- the market's number: home spread, total, or the player's line
    outcome       text check (outcome is null or outcome in ('home', 'away', 'over', 'under')),
    player_id     text,
    price_decimal numeric(8,3) not null check (price_decimal > 1),
    stake         numeric(10,2) not null check (stake > 0),
    fair_prob     numeric(6,4) check (fair_prob is null or (fair_prob > 0 and fair_prob < 1)),   -- true chance when placed
    result        text not null default 'open' check (result in ('open', 'won', 'lost', 'void')),
    settled_at    timestamptz,
    graded_by     text,                         -- 'score' when settled from the final score, 'hand' otherwise
    note          text
);
create index if not exists bets_open_idx on bsb.bets (result, game_id);

alter table bsb.bets enable row level security;
drop policy if exists members_read on bsb.bets;
create policy members_read on bsb.bets for select to authenticated using ((select bsb.is_member()));
grant select on bsb.bets to authenticated;
grant all on bsb.bets to service_role;

-- What the app lists. The closing chance is the sharp book's last fair chance for the
-- same side at the same number before kickoff; it stays empty until the game has started,
-- and when the number moved and nobody quoted the old one at the end.
create or replace view public.app_bets with (security_invoker = true) as
select b.id, b.created_at, b.placed_at, b.bookmaker, b.kind, b.description, b.game_id, b.market, b.number, b.outcome,
       b.player_id, b.price_decimal, b.stake, b.fair_prob, b.result, b.settled_at, b.graded_by, b.note,
       g.home_team, g.away_team, g.kickoff_at,
       case b.result when 'won' then round(b.stake * b.price_decimal, 2) when 'void' then b.stake when 'lost' then 0 end as returned,
       case b.result when 'won' then round(b.stake * (b.price_decimal - 1), 2) when 'void' then 0 when 'lost' then -b.stake end as profit,
       c.fair_prob as closing_fair,
       round(b.price_decimal * c.fair_prob - 1, 4) as beat_close
from bsb.bets b
left join bsb.games g on g.sport = 'nfl' and g.game_id = b.game_id
left join lateral (
    select q.fair_prob
    from bsb.line_quotes q
    where b.kind = 'game' and g.kickoff_at <= now()
      and q.game_id = b.game_id and q.market = b.market and q.number = b.number and q.outcome = b.outcome
      and q.fair_prob is not null and q.captured_at <= g.kickoff_at
    order by q.captured_at desc
    limit 1
) c on true;

revoke all on public.app_bets from public, anon, authenticated;
grant select on public.app_bets to authenticated;

-- ---------------------------------------------------------------------------
-- writing a bet down, settling it, removing it
-- ---------------------------------------------------------------------------
create or replace function public.bsb_log_bet(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare new_id bigint;
begin
    perform bsb.require_member();
    if coalesce(trim(p->>'description'), '') = '' then raise exception 'say what the bet is'; end if;
    if coalesce(trim(p->>'bookmaker'), '') = '' then raise exception 'say which sportsbook'; end if;
    if coalesce((p->>'price_decimal')::numeric, 0) <= 1 then raise exception 'the price is not valid'; end if;
    if coalesce((p->>'stake')::numeric, 0) <= 0 then raise exception 'the stake must be more than zero'; end if;
    insert into bsb.bets (user_id, placed_at, bookmaker, kind, description, game_id, market, number, outcome, player_id,
                          price_decimal, stake, fair_prob, note)
    values (auth.uid(), coalesce((p->>'placed_at')::timestamptz, now()), lower(trim(p->>'bookmaker')),
            coalesce(nullif(p->>'kind', ''), 'other'), left(trim(p->>'description'), 200), nullif(p->>'game_id', ''),
            nullif(p->>'market', ''), (p->>'number')::numeric, nullif(p->>'outcome', ''), nullif(p->>'player_id', ''),
            (p->>'price_decimal')::numeric, (p->>'stake')::numeric, (p->>'fair_prob')::numeric, nullif(trim(p->>'note'), ''))
    returning id into new_id;
    return new_id;
end $$;

-- by hand: won / lost / void (stake returned) / open (undo)
create or replace function public.bsb_settle_bet(p_id bigint, p_result text) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    if p_result not in ('open', 'won', 'lost', 'void') then raise exception 'unknown result %', p_result; end if;
    update bsb.bets
       set result = p_result,
           settled_at = case when p_result = 'open' then null else now() end,
           graded_by = case when p_result = 'open' then null else 'hand' end
     where id = p_id;
    if not found then raise exception 'no such bet'; end if;
end $$;

create or replace function public.bsb_delete_bet(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    delete from bsb.bets where id = p_id;
    if not found then raise exception 'no such bet'; end if;
end $$;

-- Settle open bets from what is known: game bets from the final score, player bets from
-- the stat line the weekly results filled in. A tie with the number returns the stake.
-- Bets it cannot place (written by hand, or the game is not final) are left open.
create or replace function bsb.grade_bets() returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0; m int;
begin
    with final as (
        select b.id,
               case b.market
                   when 'moneyline' then g.home_score - g.away_score
                   when 'spread'    then g.home_score + b.number - g.away_score
                   when 'total'     then g.home_score + g.away_score - b.number
               end as margin,          -- above zero: the home side, or the over, won
               b.outcome in ('home', 'over') as backs_first
        from bsb.bets b
        join bsb.games g on g.sport = 'nfl' and g.game_id = b.game_id
        where b.result = 'open' and b.kind = 'game' and b.market in ('moneyline', 'spread', 'total')
          and b.outcome is not null and (b.market = 'moneyline' or b.number is not null)
          and g.home_score is not null and g.away_score is not null
          and (b.market = 'total') = (b.outcome in ('over', 'under'))
    )
    update bsb.bets b
       set result = case when f.margin = 0 then 'void' when (f.margin > 0) = f.backs_first then 'won' else 'lost' end,
           settled_at = now(), graded_by = 'score'
      from final f where f.id = b.id and f.margin is not null;
    get diagnostics n = row_count;

    with final as (
        select b.id, a.actual - b.number as margin, b.outcome = 'over' as backs_over
        from bsb.bets b
        join lateral (
            select p.actual from bsb.prop_prices p
            where p.game_id = b.game_id and p.player_id = b.player_id and p.stat = b.market and p.actual is not null
            limit 1
        ) a on true
        where b.result = 'open' and b.kind = 'player' and b.outcome in ('over', 'under') and b.number is not null
    )
    update bsb.bets b
       set result = case when f.margin = 0 then 'void' when (f.margin > 0) = f.backs_over then 'won' else 'lost' end,
           settled_at = now(), graded_by = 'score'
      from final f where f.id = b.id;
    get diagnostics m = row_count;
    return n + m;
end $$;
revoke all on function bsb.grade_bets() from public, anon, authenticated;
grant execute on function bsb.grade_bets() to service_role;

create or replace function public.bsb_grade_bets() returns int
language plpgsql security definer set search_path = '' as $$
begin
    perform bsb.require_member();
    return bsb.grade_bets();
end $$;

revoke all on function public.bsb_log_bet(jsonb), public.bsb_settle_bet(bigint, text), public.bsb_delete_bet(bigint),
                       public.bsb_grade_bets() from public, anon;
grant execute on function public.bsb_log_bet(jsonb), public.bsb_settle_bet(bigint, text), public.bsb_delete_bet(bigint),
                          public.bsb_grade_bets() to authenticated;

commit;
