"""Big Surf Bets projection model (Phase 2).

Player-week projections for QB/RB/WR/TE: per-stat means, DK/PPR points with a
full outcome distribution, and over/under probabilities for prop lines.

    data.py      load nflverse frames (cached parquet)
    features.py  leak-free feature frame, identical for history and upcoming weeks
    dist.py      outcome distributions (negative binomial counts, empirical yards)
    train.py     LightGBM per stat + out-of-fold residual distributions
    backtest.py  holdout evaluation vs naive baselines + calibration
    project.py   upcoming-week projections → bsb.projections
"""
