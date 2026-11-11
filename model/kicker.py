"""Kicker projections for DraftKings (showdown slates roster kickers; classic does not).

DK scores a kicker +1 per extra point and +3 / +4 / +5 per field goal from
0–39 / 40–49 / 50+ yards. A kicker's score is mostly his team's: how many
points Vegas expects them to score and whether they are in a dome. Which kicker
it is matters little. So the model is one row per team per game, a small tree
model on the matchup, and the same empirical outcome shape as everything else.

The upcoming week's kicker for a team is whoever kicked in its last game."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import polars as pl

from .data import NFLData
from .dist import QUANTILES, Empirical
from .features import _prior_ewm, _team_schedule
from .train import _fit_one

log = logging.getLogger(__name__)

PARAMS = dict(
    n_estimators=200, learning_rate=0.02, num_leaves=5, min_child_samples=60,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=20.0,
    verbose=-1, n_jobs=-1, seed=7,
)
FEATURES = ["implied_total", "opp_implied_total", "spread_team", "total_line", "is_home", "is_dome", "k_dk_s", "k_dk_l", "k_fga_l"]


def dk_points() -> pl.Expr:
    f = lambda c: pl.col(c).cast(pl.Float64).fill_null(0.0)  # noqa: E731
    return (
        f("pat_made") + 3 * (f("fg_made_0_19") + f("fg_made_20_29") + f("fg_made_30_39"))
        + 4 * f("fg_made_40_49") + 5 * (f("fg_made_50_59") + f("fg_made_60_"))
    )


def build(data: NFLData, upcoming: tuple[int, int] | None = None, out_ids: set[str] | None = None) -> pl.DataFrame:
    """Feature frame: every played team-game, plus stat-less rows for `upcoming`
    carrying the kicker each team used last."""
    tsched = _team_schedule(data.schedules)
    cutoff = None
    if upcoming:
        cutoff = upcoming[0] * 100 + upcoming[1]
        before = pl.col("t") < cutoff
        tsched = tsched.filter((pl.col("played") & before) | (pl.col("t") == cutoff)).with_columns(
            (pl.col("played") & before).alias("played"))
    else:
        tsched = tsched.filter(pl.col("played"))

    kicks = data.stats.filter(
        (pl.col("position") == "K") & ((pl.col("fg_att").fill_null(0) + pl.col("pat_att").fill_null(0)) > 0)
    ).with_columns(dk_points().alias("dk"), pl.col("fg_att").cast(pl.Float64).fill_null(0.0).alias("fga"))
    if cutoff:
        kicks = kicks.filter(pl.col("season") * 100 + pl.col("week") < cutoff)
    per_team = kicks.group_by("season", "week", "team").agg(
        pl.col("dk").sum(), pl.col("fga").sum(),
        pl.col("player_id").sort_by("dk", descending=True).first().alias("kicker_id"),
        pl.col("player_display_name").sort_by("dk", descending=True).first().alias("kicker_name"),
    )
    df = tsched.join(per_team, on=["season", "week", "team"], how="left").with_columns(
        pl.col("played").not_().alias("is_future"),
        # a team that attempted no kick scored a real zero
        pl.when(pl.col("played")).then(pl.col("dk").fill_null(0.0)).alias("dk"),
        pl.when(pl.col("played")).then(pl.col("fga").fill_null(0.0)).alias("fga"),
        (pl.col("total_line") - pl.col("implied_total")).alias("opp_implied_total"),
    ).sort("team", "t")
    df = df.with_columns(
        _prior_ewm("dk", 6, "team").alias("k_dk_s"), _prior_ewm("dk", 16, "team").alias("k_dk_l"),
        _prior_ewm("fga", 16, "team").alias("k_fga_l"),
        # the kicker a team used last carries into its next game
        pl.col("kicker_id").forward_fill().over("team"), pl.col("kicker_name").forward_fill().over("team"),
    )
    if out_ids:
        gone = pl.col("is_future") & pl.col("kicker_id").is_in(list(out_ids))
        df = df.with_columns(pl.when(gone).then(None).otherwise(pl.col("kicker_id")).alias("kicker_id"))
    return df.sort("t", "team")


@dataclass
class KickerModel:
    booster: lgb.Booster
    dist: Empirical
    seasons: list[int]
    n_rows: int
    oof_mae: float


def fit(df: pl.DataFrame, seasons: list[int], params: dict | None = None) -> KickerModel:
    params = {**PARAMS, **(params or {})}
    tr = df.filter(pl.col("season").is_in(seasons) & ~pl.col("is_future") & pl.col("implied_total").is_not_null())
    X, y, season = tr.select(FEATURES).to_numpy().astype(np.float64), tr["dk"].to_numpy().astype(np.float64), tr["season"].to_numpy()
    oof = np.zeros(tr.height)
    for s in seasons:  # leave-one-season-out
        te = season == s
        if te.any() and (~te).any():
            oof[te] = _fit_one(X[~te], y[~te], "l2", params).predict(X[te])
    return KickerModel(_fit_one(X, y, "l2", params), Empirical.fit(oof, y, n_buckets=6, min_bucket=250), list(seasons), tr.height,
                       float(np.abs(oof - y).mean()))


def predict(model: KickerModel, df: pl.DataFrame) -> pl.DataFrame:
    raw = model.booster.predict(df.select(FEATURES).to_numpy().astype(np.float64))
    return df.with_columns(
        pl.Series("proj_dk", model.dist.mean(raw)), pl.Series("proj_dk_std", model.dist.std(raw)),
        *[pl.Series(f"proj_dk_p{int(q * 100)}", model.dist.quantile(raw, q)) for q in QUANTILES],
    )


def evaluate(df: pl.DataFrame, train_seasons: list[int], test_season: int, weeks: tuple[int, int] | None = None) -> dict:
    """Holdout accuracy against the team's own recent average and the league average."""
    model = fit(df, train_seasons)
    test = df.filter((pl.col("season") == test_season) & ~pl.col("is_future") & pl.col("k_dk_l").is_not_null()
                     & pl.col("implied_total").is_not_null())
    if weeks:
        test = test.filter(pl.col("week").is_between(weeks[0], weeks[1]))
    pred = predict(model, test)
    y, p = pred["dk"].to_numpy(), pred["proj_dk"].to_numpy()
    league = float(df.filter(pl.col("season").is_in(train_seasons) & ~pl.col("is_future"))["dk"].mean())
    mae = lambda a: float(np.abs(a - y).mean())  # noqa: E731
    rank = lambda a: float(np.corrcoef(a.argsort().argsort(), y.argsort().argsort())[0, 1])  # noqa: E731
    return dict(
        n=pred.height, model_mae=mae(p), recent_avg_mae=mae(pred["k_dk_l"].to_numpy()), league_avg_mae=mae(np.full(len(y), league)),
        rank_model=rank(p), rank_recent_avg=rank(pred["k_dk_l"].to_numpy()), bias=float((p - y).mean()),
        cover_p10_p90=float(((y >= pred["proj_dk_p10"].to_numpy()) & (y <= pred["proj_dk_p90"].to_numpy())).mean()),
        mean_actual=float(y.mean()), oof_mae=model.oof_mae,
    )
