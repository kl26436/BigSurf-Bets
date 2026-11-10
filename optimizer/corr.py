"""Role correlations: how much two players' results move together once you
account for what each was expected to score.

Estimated from history as the correlation of *surprises* (actual DK points minus
the player's recent average), by role pair — e.g. when a QB beats expectation,
how often does his WR1? Using surprises, not raw scores, matters: raw scores
are correlated simply because good offenses have good players, and that part is
already in the projections.

Roles per team: QB, RB1, RB2, WR1, WR2, WR3, TE1, DST. The matrix covers
same-team pairs and opposing-team pairs within a game. It is fitted once and
stored in role_corr.json (`bsb lineups fit-corr` to refresh)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import polars as pl

ROLES = ["QB", "RB1", "RB2", "WR1", "WR2", "WR3", "TE1", "DST"]
PATH = Path(__file__).with_name("role_corr.json")
_DEPTH = {"QB": 1, "RB": 2, "WR": 3, "TE": 1}


def assign_roles(df: pl.DataFrame, by: list[str], rank_col: str) -> pl.DataFrame:
    """Add `role` (QB, RB1, … or null for depth players) by ranking each
    team's players at a position on `rank_col` (expected points)."""
    r = pl.col(rank_col).rank("ordinal", descending=True).over([*by, "pos"])
    role = pl.when(pl.col("pos") == "DST").then(pl.lit("DST"))
    for pos, depth in _DEPTH.items():
        for k in range(1, depth + 1):
            name = pos if pos == "QB" else f"{pos}{k}"
            role = role.when((pl.col("pos") == pos) & (r == k)).then(pl.lit(name))
    return df.with_columns(role.alias("role"))


def _normal_scores(x: np.ndarray) -> np.ndarray:
    """Rank-transform to standard normal scores (keeps NaN)."""
    from scipy.stats import norm, rankdata

    out = np.full(x.shape, np.nan)
    ok = ~np.isnan(x)
    out[ok] = norm.ppf((rankdata(x[ok]) - 0.5) / ok.sum())
    return out


def fit(players: pl.DataFrame, dst: pl.DataFrame, seasons: list[int]) -> dict:
    """players: model.features.build() frame; dst: model.dst.build() frame."""
    p = players.filter(pl.col("season").is_in(seasons) & ~pl.col("is_future") & pl.col("dk_l").is_not_null()).select(
        "season", "week", "team", "opponent", "pos", (pl.col("dk") - pl.col("dk_l")).alias("resid"),
        pl.col("dk_l").alias("exp"),
    )
    d = dst.filter(pl.col("season").is_in(seasons) & ~pl.col("is_future") & pl.col("def_dk_l").is_not_null()).select(
        "season", "week", "team", "opponent", pl.lit("DST").alias("pos"),
        (pl.col("dk") - pl.col("def_dk_l")).alias("resid"), pl.col("def_dk_l").alias("exp"),
    )
    key = ["season", "week", "team"]
    long = assign_roles(pl.concat([p, d]), key, "exp").filter(pl.col("role").is_not_null())
    wide = long.pivot("role", index=[*key, "opponent"], values="resid", aggregate_function="first")
    for r in ROLES:
        if r not in wide.columns:
            wide = wide.with_columns(pl.lit(None, pl.Float64).alias(r))
    opp = wide.select("season", "week", pl.col("team").alias("opponent"), *[pl.col(r).alias(f"opp_{r}") for r in ROLES])
    both = wide.join(opp, on=["season", "week", "opponent"], how="inner")
    cols = [*ROLES, *[f"opp_{r}" for r in ROLES]]
    Z = np.column_stack([_normal_scores(both[c].to_numpy().astype(float)) for c in cols])
    C = np.ma.corrcoef(np.ma.masked_invalid(Z), rowvar=False).filled(0.0)
    n = len(ROLES)
    same, opp_m = C[:n, :n], C[:n, n:]
    opp_m = (opp_m + opp_m.T) / 2  # (A's role i, B's role j) and (B's i, A's j) are the same quantity
    return dict(
        roles=ROLES, seasons=seasons, n_team_games=both.height,
        same_team=np.round(same, 3).tolist(), opponent=np.round(opp_m, 3).tolist(),
    )


def save(c: dict, path: Path = PATH) -> None:
    path.write_text(json.dumps(c, indent=1) + "\n", encoding="utf-8")


def load(path: Path = PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def game_matrix(c: dict) -> np.ndarray:
    """16×16 correlation matrix for one game (team A's 8 roles, then team B's),
    nudged to be positive semi-definite so it can drive a simulation."""
    same, opp = np.array(c["same_team"]), np.array(c["opponent"])
    M = np.block([[same, opp], [opp.T, same]])
    M = (M + M.T) / 2
    w, v = np.linalg.eigh(M)
    M = (v * np.clip(w, 1e-6, None)) @ v.T
    s = np.sqrt(np.diag(M))
    return M / np.outer(s, s)
