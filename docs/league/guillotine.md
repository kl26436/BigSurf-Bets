# Guillotine league: chop odds and waiver bids

`bsb league bids` (runs after every projection run) answers, for the Sleeper guillotine league my roster is in:
who is likely to be chopped, what each free agent is worth to me, and what to bid.

Code: `league/guillotine.py` (maths, no database), `league/bids.py` (load / store / report),
`ingest/sleeper_league.py` (rosters + every transaction), migration `0010_guillotine.sql`.
App: My league → Waiver bids (`app_waiver_run`, `app_waiver_recs`).

## Method
1. Player level = this week's projection (if any) blended 50/50 with season form (60% season average, 40% last four weeks).
   Zero in bye weeks; injured reserve / Sleeper "Inactive" = out for the next 4 team games; Out / Doubtful = out this week.
2. Team curve = best legal lineup per remaining week → mean and spread.
3. 20,000 simulated seasons; each week the lowest live score is chopped → chance of being chopped (per week) and of winning.
4. Free agent value = change in those odds with him added, same random draws.
5. Rival bids: each team's past share-of-money on the week's top three auctions (0 when it sat out), shrunk towards the
   league's, scaled by how much the player improves that team's lineup, capped at its remaining money.
6. Bid = argmax P(win at b) × (value − dollar_value × b). `dollar_value` = lineup points a dollar is expected to buy
   in later pools (rivals' best players × chance that team is chopped × weeks left × chance I am still alive).
   Same-position alternative shares the drop (either/or); one other-position bid from the money left.

## Known limits
- Future weeks use one level per player: no matchup effects after this week.
- Chopped players are not redistributed inside the simulation, so title odds of a pick-up are overstated.
- Team scores are independent (no shared-game correlation).
- The rival model has one league and one season of history; it cannot see desperation (a team at 25% chop risk may bid everything).
- `dollar_value` is a rule of thumb, not an optimum.
- Not graded yet: after each waiver run compare `bid_50/80/95` with the actual winning bids in `fantasy_transactions`.
