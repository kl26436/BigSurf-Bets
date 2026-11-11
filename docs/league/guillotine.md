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
- Prices are graded from the next run on (`bids.grade_prices`, shown in the app as "How last week's prices did"): each
  priced player's highest rival bid beside the 50 / 80 / 95% prices. A handful of players a week: read it over a season.

## Also worked out each run (stored on `waiver_runs`, shown on My league)
- `lineup`: the best legal lineup for the week about to be played, per player `start` and the spot. The app compares it
  with the lineup set in Sleeper. Falls back to a plain same-position rule when the roster changed after the run.
- `advice.needs`: each starting spot against the median of the same spot on the other live teams.
- `coming`: per rival, the chance it is chopped this week / within three weeks, and its three best players for my lineup.
  A team chopped after this week's games has its players in next Wednesday's auction.
- `advice.verdict` (now / wait / either / hold): the best player on offer now against the best one expected to come
  free after this week's chop (each rival's best player for me × that rival's chance of going). A rule of thumb: it
  ignores that every other team bids on those players too, and that money not spent keeps its value.
- After Thursday night the latest projection run no longer carries teams that have played. The league run uses each
  player's newest projection for the week instead, so a Thursday player is not counted as zero.
