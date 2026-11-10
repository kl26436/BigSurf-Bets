"""Fit the projection model.

One gradient-boosted model per box-score stat (Poisson loss for counts, squared
loss for yards), each trained on the positions that actually produce that stat.
Fantasy points are *derived* from the stat projections with the site's scoring
rules rather than modelled separately, so DK points, PPR points and prop
probabilities always agree with each other. (A direct DK-points model was tried
and blended: no gain in leave-one-season-out validation, so it was dropped.)

Distributions are fitted on leave-one-season-out predictions (see dist.py)."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import lightgbm as lgb
import numpy as np
import polars as pl

from .dist import QUANTILES, Empirical, NegBin
from .features import POSITIONS, feature_columns

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Spec:
    positions: tuple[str, ...]
    objective: str  # "poisson" | "l2"
    dist: str       # "nb" | "emp"


SKILL = ("RB", "WR", "TE")
SPECS: dict[str, Spec] = {
    "attempts": Spec(("QB",), "poisson", "nb"),
    "completions": Spec(("QB",), "poisson", "nb"),
    "passing_yards": Spec(("QB",), "l2", "emp"),
    "passing_tds": Spec(("QB",), "poisson", "nb"),
    "interceptions": Spec(("QB",), "poisson", "nb"),
    "carries": Spec(tuple(POSITIONS), "poisson", "nb"),
    "rushing_yards": Spec(tuple(POSITIONS), "l2", "emp"),
    "rushing_tds": Spec(tuple(POSITIONS), "poisson", "nb"),
    "targets": Spec(SKILL, "poisson", "nb"),
    "receptions": Spec(SKILL, "poisson", "nb"),
    "receiving_yards": Spec(SKILL, "l2", "emp"),
    "receiving_tds": Spec(SKILL, "poisson", "nb"),
}
PARAMS = dict(
    n_estimators=350, learning_rate=0.03, num_leaves=15, min_child_samples=60,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.5, reg_lambda=10.0,
    verbose=-1, n_jobs=-1, seed=7,
)


@dataclass
class Model:
    features: list[str]
    boosters: dict[str, lgb.Booster]
    dists: dict[str, NegBin | Empirical]
    points_dist: dict[str, dict[str, Empirical]]   # {"dk"|"ppr": {pos: Empirical}}
    fumble_rate: dict[str, float]                   # fumbles lost per opportunity, by position
    seasons: list[int]
    n_rows: int
    oof_metrics: dict[str, float] = field(default_factory=dict)


def _fit_one(X: np.ndarray, y: np.ndarray, objective: str, params: dict) -> lgb.Booster:
    obj = {"poisson": "poisson", "l2": "regression"}[objective]
    m = lgb.LGBMRegressor(objective=obj, **params)
    m.fit(X, np.clip(y, 0, None) if objective == "poisson" else y)
    return m.booster_


def _predict_stats(boosters: dict[str, lgb.Booster], df: pl.DataFrame, feats: list[str]) -> dict[str, np.ndarray]:
    """Mean projection per stat; 0 for positions a stat isn't modelled for."""
    X = df.select(feats).to_numpy().astype(np.float64)
    pos = df["pos"].to_numpy()
    out = {}
    for stat, spec in SPECS.items():
        m = np.isin(pos, spec.positions)
        p = np.zeros(df.height)
        if m.any():
            p[m] = boosters[stat].predict(X[m])
        out[stat] = np.clip(p, 0, None) if spec.objective == "poisson" else p
    return out


def _fumble_rate(df: pl.DataFrame) -> dict[str, float]:
    opp = pl.col("carries") + pl.col("receptions") + pl.col("attempts") + pl.col("sacks")
    r = df.group_by("pos").agg((pl.col("fumbles_lost").sum() / opp.sum()).alias("r"))
    return dict(zip(r["pos"], r["r"], strict=True))


def points_from_stats(
    p: dict[str, np.ndarray], pos: np.ndarray, dists: dict[str, NegBin | Empirical], fumble_rate: dict[str, float]
) -> dict[str, np.ndarray]:
    """Expected DK and PPR points from projected stat means. DK's 300/100-yard
    bonuses need the yardage distributions, not just the means."""
    fl = np.array([fumble_rate.get(x, 0.0) for x in pos]) * (
        p["carries"] + p["receptions"] + p["attempts"] * 1.07  # ~7% of dropbacks end in a sack
    )
    bonus = 3 * (
        dists["passing_yards"].prob_over(p["passing_yards"], 299.5) * (p["passing_yards"] > 0)
        + dists["rushing_yards"].prob_over(p["rushing_yards"], 99.5)
        + dists["receiving_yards"].prob_over(p["receiving_yards"], 99.5) * (p["receiving_yards"] > 0)
    )
    common = (
        0.04 * p["passing_yards"] + 4 * p["passing_tds"]
        + 0.1 * p["rushing_yards"] + 6 * p["rushing_tds"]
        + p["receptions"] + 0.1 * p["receiving_yards"] + 6 * p["receiving_tds"]
    )
    return {
        "dk": common - p["interceptions"] - fl + bonus,
        "ppr": common - 2 * p["interceptions"] - 2 * fl,
    }


def fit(df: pl.DataFrame, seasons: list[int], params: dict | None = None) -> tuple[Model, pl.DataFrame]:
    """Train on `seasons`. → (model, out-of-fold predictions for the training rows)."""
    params = {**PARAMS, **(params or {})}
    feats = feature_columns(df)
    tr = df.filter(pl.col("season").is_in(seasons) & ~pl.col("is_future"))
    X = tr.select(feats).to_numpy().astype(np.float64)
    pos, season = tr["pos"].to_numpy(), tr["season"].to_numpy()
    t0 = time.time()

    boosters: dict[str, lgb.Booster] = {}
    oof = {s: np.zeros(tr.height) for s in SPECS}
    for stat, spec in SPECS.items():
        y = tr[stat].to_numpy().astype(np.float64)
        m = np.isin(pos, spec.positions)
        boosters[stat] = _fit_one(X[m], y[m], spec.objective, params)
        for s in seasons:  # leave-one-season-out predictions
            fold_tr, fold_te = m & (season != s), m & (season == s)
            if fold_te.any() and fold_tr.any():
                oof[stat][fold_te] = _fit_one(X[fold_tr], y[fold_tr], spec.objective, params).predict(X[fold_te])
        if spec.objective == "poisson":
            oof[stat] = np.clip(oof[stat], 0, None)
    log.info("fitted %d models on %d rows × %d features (%.0fs)", len(boosters), tr.height, len(feats), time.time() - t0)

    dists: dict[str, NegBin | Empirical] = {}
    for stat, spec in SPECS.items():
        m = np.isin(pos, spec.positions)
        y = tr[stat].to_numpy().astype(np.float64)[m]
        dists[stat] = NegBin.fit(oof[stat][m], y) if spec.dist == "nb" else Empirical.fit(oof[stat][m], y)

    fumble_rate = _fumble_rate(tr)
    pts = points_from_stats(oof, pos, dists, fumble_rate)
    points_dist = {
        k: {p: Empirical.fit(pts[k][pos == p], tr[k].to_numpy()[pos == p], n_buckets=12) for p in POSITIONS}
        for k in ("dk", "ppr")
    }
    metrics = {
        f"oof_mae_{k}": float(np.abs(v - tr[k].to_numpy()).mean())
        for k, v in {**{s: oof[s] for s in SPECS}, "dk": pts["dk"], "ppr": pts["ppr"]}.items()
    }
    model = Model(feats, boosters, dists, points_dist, fumble_rate, list(seasons), tr.height, metrics)
    oof_df = tr.select("player_id", "season", "week").with_columns(
        *[pl.Series(f"proj_{s}", oof[s]) for s in SPECS],
        pl.Series("proj_dk_raw", pts["dk"]), pl.Series("proj_ppr_raw", pts["ppr"]),
    )
    return model, oof_df


def predict(model: Model, df: pl.DataFrame) -> pl.DataFrame:
    """Projections for every row of a feature frame: stat means, DK/PPR mean,
    and the DK/PPR outcome distribution (std + quantiles)."""
    p = _predict_stats(model.boosters, df, model.features)
    pos = df["pos"].to_numpy()
    pts = points_from_stats(p, pos, model.dists, model.fumble_rate)
    cols = [pl.Series(f"proj_{s}", p[s]) for s in SPECS]
    for k in ("dk", "ppr"):
        raw = pts[k]
        mean, std = np.zeros(df.height), np.zeros(df.height)
        qs = {q: np.zeros(df.height) for q in QUANTILES}
        for ps in POSITIONS:
            m = pos == ps
            if not m.any():
                continue
            d = model.points_dist[k][ps]
            mean[m], std[m] = d.mean(raw[m]), d.std(raw[m])
            for q in QUANTILES:
                qs[q][m] = d.quantile(raw[m], q)
        cols += [pl.Series(f"proj_{k}_raw", raw), pl.Series(f"proj_{k}", mean), pl.Series(f"proj_{k}_std", std)]
        cols += [pl.Series(f"proj_{k}_p{int(q * 100)}", v) for q, v in qs.items()]
    return df.with_columns(cols)


def prob_over(model: Model, stat: str, mean: np.ndarray, line: np.ndarray) -> np.ndarray:
    """P(stat > line) given projected means — the number to compare with a
    book's no-vig price on the over."""
    return model.dists[stat].prob_over(np.asarray(mean, float), np.asarray(line, float))
