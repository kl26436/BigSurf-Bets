"""Big Surf Bets lineup engine (Phase 3).

    slate.py      a DraftKings slate joined to projections → the player pool
    corr.py       how player outcomes move together (QB ↔ his receivers, RB ↔ his defense …)
    sim.py        correlated simulation of a slate → every lineup gets a score distribution
    classic.py    salary-cap solver for DK classic (QB, 2 RB, 3 WR, TE, FLEX, DST)
    portfolio.py  many lineups: candidate pool → pick a set with exposure caps and overlap limits
"""
