"""Big Surf Bets market tools: turn raw odds snapshots into prices we can act on.

    props.py   player props → canonical stat/line, matched to our players, de-vigged,
               priced by the projection model; graded after the games
    lines.py   game lines (moneyline / spread / total) across books → best price,
               fair value from Pinnacle, +EV quotes and true arbitrage
"""
