"""Correlated simulation of a slate.

Each simulation is one way Sunday could go: every player gets a DK score drawn
from his own projected distribution (the p10…p90 the model publishes), and the
draws are tied together by the role correlations in corr.py — a QB's big day
lifts his receivers and sinks the defense facing him.

That turns a lineup from "sum of projections" into a full distribution: its
floor, its ceiling, and how often it lands a score no other lineup reaches."""

from __future__ import annotations

import numpy as np
import polars as pl
from scipy.stats import norm

from . import corr as corr_mod

DEPTH_ROLE = {"QB": "QB", "RB": "RB2", "WR": "WR3", "TE": "TE1", "DST": "DST"}
DEPTH_LOADING = 0.6   # depth players share less of their role's swing than the starter
KNOTS = np.array([0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 1.0])


def quantile_knots(pool: pl.DataFrame) -> np.ndarray:
    """(n_players, 7) inverse-CDF knots: floor, p10…p90, ceiling. The ceiling is
    set so the distribution's mean equals the projection (the top 10% carries
    the skew), within sane limits."""
    q = pool.select("dk_p10", "dk_p25", "dk_p50", "dk_p75", "dk_p90").to_numpy().astype(float)
    mean = pool["dk_mean"].to_numpy().astype(float)
    floor = np.where(pool["pos"].to_numpy() == "DST", -4.0, -2.0)
    lo = np.maximum(q[:, 0] - (q[:, 1] - q[:, 0]), floor)
    lo = np.minimum(lo, q[:, 0])
    w = np.diff(KNOTS)
    known = (w[0] * (lo + q[:, 0]) + w[1] * (q[:, 0] + q[:, 1]) + w[2] * (q[:, 1] + q[:, 2])
             + w[3] * (q[:, 2] + q[:, 3]) + w[4] * (q[:, 3] + q[:, 4])) / 2
    hi = 2 * (mean - known) / w[5] - q[:, 4]
    spread = np.maximum(q[:, 4] - q[:, 3], 0.5)
    hi = np.clip(hi, q[:, 4] + 0.5 * spread, q[:, 4] + 6 * spread)
    return np.column_stack([lo, q, hi])


def simulate(pool: pl.DataFrame, corr: dict | None = None, n_sims: int = 10_000, seed: int = 7) -> np.ndarray:
    """→ (n_sims, n_players) simulated DK points, columns in pool order."""
    corr = corr or corr_mod.load()
    roles = corr["roles"]
    L = np.linalg.cholesky(corr_mod.game_matrix(corr))
    rng = np.random.default_rng(seed)
    p = corr_mod.assign_roles(pool, ["team"], "dk_mean")
    role = [r if r is not None else DEPTH_ROLE[pos] for r, pos in zip(p["role"], p["pos"], strict=True)]
    primary = p["role"].is_not_null().to_numpy()
    team, game = p["team"].to_numpy(), p["game"].to_numpy()
    latent = np.empty((n_sims, pool.height))
    for g in np.unique(game):
        idx = np.flatnonzero(game == g)
        teams = sorted(set(team[idx]))
        z = rng.standard_normal((n_sims, 2 * len(roles))) @ L.T   # role factors for both teams
        for i in idx:
            col = roles.index(role[i]) + (len(roles) if team[i] == teams[-1] and len(teams) > 1 else 0)
            a = 1.0 if primary[i] else DEPTH_LOADING
            latent[:, i] = a * z[:, col] + np.sqrt(1 - a * a) * rng.standard_normal(n_sims)
    u = norm.cdf(latent)
    knots = quantile_knots(pool)
    out = np.empty_like(u)
    for i in range(pool.height):
        out[:, i] = np.interp(u[:, i], KNOTS, knots[i])
    return out
