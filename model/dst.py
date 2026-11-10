"""Team defense / special teams (DST) projections for DraftKings.

DK scores a DST on sacks (1), interceptions (2), fumble recoveries (2),
defensive and return touchdowns (6), safeties and blocked kicks (2), plus a
points-allowed tier (+10 for a shutout down to −4 for 35+). Each component gets
its own small model; DK points are the scoring rule applied to the projections.

What drives a DST is mostly the *opponent*: how many points Vegas expects them
to score, whether they are likely to trail and throw, and how sack- and
turnover-prone their quarterback is. The defense's own form matters less than
people think and is noisy, so features lean on the matchup.

One row per team per game; features use only earlier games, and upcoming games
run through the same code as history (same leak guard as the player model)."""

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

# stat → loss. points_allowed is projected for display; pa_pts (the DK tier
# score) is what feeds the fantasy total.
COMPONENTS = {
    "sacks": "poisson", "interceptions": "poisson", "fumble_recoveries": "poisson", "tds": "poisson",
    "pa_pts": "l2", "points_allowed": "l2",
}
PARAMS = dict(
    n_estimators=250, learning_rate=0.02, num_leaves=6, min_child_samples=40,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.6, reg_lambda=20.0,
    verbose=-1, n_jobs=-1, seed=7,
)
DEF_ROLL = ["sacks", "interceptions", "fumble_recoveries", "tds", "points_allowed", "dk", "qb_hits", "tfl", "pass_defended"]
OFF_ROLL = ["off_sacks_taken", "off_ints", "off_fum_lost", "off_points", "off_attempts", "off_dk_given"]


def pa_tier(points_allowed: pl.Expr) -> pl.Expr:
    """DraftKings points-allowed tier score."""
    p = points_allowed
    return (
        pl.when(p <= 0).then(10).when(p <= 6).then(7).when(p <= 13).then(4).when(p <= 20).then(1)
        .when(p <= 27).then(0).when(p <= 34).then(-1).otherwise(-4)
    )


def _qb_form(stats: pl.DataFrame) -> pl.DataFrame:
    """Per QB, after each game: career attempts and long-run sack / INT rates."""
    q = (
        stats.filter((pl.col("position_group") == "QB") & (pl.col("attempts") > 0))
        .select(
            pl.col("player_id").alias("qb_id"), (pl.col("season") * 100 + pl.col("week")).alias("qb_t"),
            pl.col("attempts").cast(pl.Float64), pl.col("passing_interceptions").cast(pl.Float64).alias("ints"),
            pl.col("sacks_suffered").cast(pl.Float64).alias("sk"),
        )
        .sort("qb_id", "qb_t")
    )
    ew = lambda c: pl.col(c).ewm_mean(span=16, ignore_nulls=True).over("qb_id")  # noqa: E731
    return q.with_columns(
        pl.col("attempts").cum_sum().over("qb_id").alias("opp_qb_career_att"),
        (ew("ints") / ew("attempts")).alias("opp_qb_int_rate"),
        (ew("sk") / (ew("attempts") + ew("sk"))).alias("opp_qb_sack_rate"),
    ).select("qb_id", "qb_t", "opp_qb_career_att", "opp_qb_int_rate", "opp_qb_sack_rate").sort("qb_t")


def build(data: NFLData, upcoming: tuple[int, int] | None = None) -> pl.DataFrame:
    """Feature frame: every played team-game, plus stat-less rows for `upcoming`."""
    if data.team_stats is None:
        raise ValueError("NFLData.team_stats is required for the DST model")
    tsched = _team_schedule(data.schedules)
    if upcoming:
        cutoff = upcoming[0] * 100 + upcoming[1]
        # the target week is treated as unplayed even if results exist (backtests, re-runs)
        before = pl.col("t") < cutoff
        tsched = tsched.filter((pl.col("played") & before) | (pl.col("t") == cutoff)).with_columns(
            (pl.col("played") & before).alias("played"),
            pl.when(before).then(pl.col("points_for")).alias("points_for"),
            pl.when(before).then(pl.col("points_against")).alias("points_against"),
        )
    else:
        tsched = tsched.filter(pl.col("played"))

    f = lambda c: pl.col(c).cast(pl.Float64).fill_null(0.0)  # noqa: E731
    ts = data.team_stats.select(
        "season", "week", "team",
        f("def_sacks").alias("sacks"), f("def_interceptions").alias("interceptions"),
        f("fumble_recovery_opp").alias("fumble_recoveries"),
        (f("def_tds") + f("special_teams_tds")).alias("tds"), f("def_tds").alias("def_tds_only"),
        f("def_safeties").alias("safeties"),
        (f("def_punt_blocks") + f("def_fg_blocks") + f("def_pat_blocks")).alias("blocks"),
        f("def_qb_hits").alias("qb_hits"), f("def_tackles_for_loss").alias("tfl"), f("def_pass_defended").alias("pass_defended"),
        f("sacks_suffered").alias("off_sacks_taken"), f("passing_interceptions").alias("off_ints"),
        (f("sack_fumbles_lost") + f("rushing_fumbles_lost") + f("receiving_fumbles_lost")).alias("off_fum_lost"),
        f("attempts").alias("off_attempts"),
    ).unique(["season", "week", "team"])
    if upcoming:
        ts = ts.filter(pl.col("season") * 100 + pl.col("week") < cutoff)

    df = tsched.join(ts, on=["season", "week", "team"], how="left")
    # points the *defense* is charged with: the opponent's score minus points
    # their defense scored against our offense (pick-sixes, safeties)
    opp = df.select(
        "season", "week", pl.col("team").alias("opponent"),
        pl.col("def_tds_only").alias("_opp_def_tds"), pl.col("safeties").alias("_opp_safeties"),
        pl.col("qb_id").alias("opp_qb_id"), pl.col("implied_total").alias("opp_implied_total"),
    )
    df = df.join(opp, on=["season", "week", "opponent"], how="left").with_columns(
        pl.when(pl.col("played")).then(
            (pl.col("points_against") - 7 * pl.col("_opp_def_tds").fill_null(0) - 2 * pl.col("_opp_safeties").fill_null(0)).clip(0)
        ).cast(pl.Float64).alias("points_allowed"),
        pl.col("points_for").cast(pl.Float64).alias("off_points"),
        pl.col("played").not_().alias("is_future"),
    ).with_columns(
        pl.when(pl.col("played")).then(pa_tier(pl.col("points_allowed"))).cast(pl.Float64).alias("pa_pts"),
    ).with_columns(
        (
            pl.col("sacks") + 2 * pl.col("interceptions") + 2 * pl.col("fumble_recoveries") + 6 * pl.col("tds")
            + 2 * pl.col("safeties") + 2 * pl.col("blocks") + pl.col("pa_pts")
        ).alias("dk"),
    )
    # what an offense hands to opposing DSTs = the DK score of the defense it faced
    given = df.select("season", "week", pl.col("opponent").alias("team"), pl.col("dk").alias("off_dk_given"))
    df = df.join(given, on=["season", "week", "team"], how="left").sort("team", "t")

    df = df.with_columns(
        *[_prior_ewm(c, 6, "team").alias(f"def_{c}_s") for c in DEF_ROLL],
        *[_prior_ewm(c, 16, "team").alias(f"def_{c}_l") for c in DEF_ROLL],
        *[_prior_ewm(c, 6, "team").alias(f"_{c}_s") for c in OFF_ROLL],
        *[_prior_ewm(c, 16, "team").alias(f"_{c}_l") for c in OFF_ROLL],
        # naive baselines for the backtest
        pl.col("dk").shift(1).rolling_mean(4, min_samples=1).over("team").alias("dk_l4"),
    )
    off = df.select(
        "season", "week", pl.col("team").alias("opponent"),
        *[pl.col(f"_{c}_{w}").alias(f"opp_{c.removeprefix('off_')}_{w}") for c in OFF_ROLL for w in ("s", "l")],
    )
    df = df.join(off, on=["season", "week", "opponent"], how="left").drop("^_.*$")
    df = (
        df.sort("t")
        .join_asof(_qb_form(data.stats), left_on="t", right_on="qb_t", by_left="opp_qb_id", by_right="qb_id",
                   strategy="backward", allow_exact_matches=False)
        .with_columns(
            pl.col("opp_qb_career_att").fill_null(0.0),  # no NFL attempts yet = a debut start
            (pl.col("total_line") - pl.col("opp_implied_total")).alias("own_implied_total"),
        )
    )
    return df.sort("t", "team")


FEATURES = [
    *[f"def_{c}_{w}" for c in DEF_ROLL for w in ("s", "l")],
    *[f"opp_{c.removeprefix('off_')}_{w}" for c in OFF_ROLL for w in ("s", "l")],
    "opp_implied_total", "own_implied_total", "spread_team", "total_line", "is_home", "is_dome",
    "opp_qb_career_att", "opp_qb_int_rate", "opp_qb_sack_rate",
]


@dataclass
class DSTModel:
    boosters: dict[str, lgb.Booster]
    dist: Empirical
    extras: float            # league-average points from safeties + blocked kicks
    seasons: list[int]
    n_rows: int
    oof_mae: float


def _raw_dk(p: dict[str, np.ndarray], extras: float) -> np.ndarray:
    return p["sacks"] + 2 * p["interceptions"] + 2 * p["fumble_recoveries"] + 6 * p["tds"] + p["pa_pts"] + extras


def fit(df: pl.DataFrame, seasons: list[int], params: dict | None = None) -> DSTModel:
    params = {**PARAMS, **(params or {})}
    tr = df.filter(pl.col("season").is_in(seasons) & ~pl.col("is_future") & pl.col("sacks").is_not_null())
    X, season = tr.select(FEATURES).to_numpy().astype(np.float64), tr["season"].to_numpy()
    boosters, oof = {}, {}
    for stat, objective in COMPONENTS.items():
        y = tr[stat].to_numpy().astype(np.float64)
        boosters[stat] = _fit_one(X, y, objective, params)
        oof[stat] = np.zeros(tr.height)
        for s in seasons:  # leave-one-season-out
            te = season == s
            if te.any() and (~te).any():
                oof[stat][te] = _fit_one(X[~te], y[~te], objective, params).predict(X[te])
    extras = float((2 * tr["safeties"] + 2 * tr["blocks"]).mean())
    raw, y = _raw_dk(oof, extras), tr["dk"].to_numpy()
    return DSTModel(boosters, Empirical.fit(raw, y, n_buckets=8, min_bucket=150), extras, list(seasons), tr.height,
                    float(np.abs(raw - y).mean()))


def predict(model: DSTModel, df: pl.DataFrame) -> pl.DataFrame:
    X = df.select(FEATURES).to_numpy().astype(np.float64)
    p = {s: model.boosters[s].predict(X) for s in COMPONENTS}
    raw = _raw_dk(p, model.extras)
    return df.with_columns(
        *[pl.Series(f"proj_{s}", np.clip(v, 0, None) if COMPONENTS[s] == "poisson" else v) for s, v in p.items()],
        pl.Series("proj_dk", model.dist.mean(raw)), pl.Series("proj_dk_std", model.dist.std(raw)),
        *[pl.Series(f"proj_dk_p{int(q * 100)}", model.dist.quantile(raw, q)) for q in QUANTILES],
    )


def evaluate(df: pl.DataFrame, train_seasons: list[int], test_season: int, weeks: tuple[int, int] | None = None) -> dict:
    """Holdout accuracy vs naive baselines (the defense's own recent average,
    and 'every defense scores the league average')."""
    model = fit(df, train_seasons)
    test = df.filter((pl.col("season") == test_season) & ~pl.col("is_future") & pl.col("def_dk_l").is_not_null())
    if weeks:
        test = test.filter(pl.col("week").is_between(weeks[0], weeks[1]))
    pred = predict(model, test)
    y, p = pred["dk"].to_numpy(), pred["proj_dk"].to_numpy()
    league = float(df.filter(pl.col("season").is_in(train_seasons) & ~pl.col("is_future"))["dk"].mean())
    mae = lambda a: float(np.abs(a - y).mean())  # noqa: E731
    rank = lambda a: float(np.corrcoef(a.argsort().argsort(), y.argsort().argsort())[0, 1])  # noqa: E731
    # the DFS question: did the defenses we ranked highest each week actually score more?
    wk = pred.with_columns(pl.col("proj_dk").rank(descending=True).over("week").alias("r"))
    return dict(
        n=pred.height, model_mae=mae(p), recent_avg_mae=mae(pred["def_dk_l"].to_numpy()),
        last4_mae=mae(pred["dk_l4"].to_numpy()), league_avg_mae=mae(np.full(len(y), league)),
        rank_model=rank(p), rank_recent_avg=rank(pred["def_dk_l"].to_numpy()), bias=float((p - y).mean()),
        cover_p10_p90=float(((y >= pred["proj_dk_p10"].to_numpy()) & (y <= pred["proj_dk_p90"].to_numpy())).mean()),
        top5_actual=float(wk.filter(pl.col("r") <= 5)["dk"].mean()),
        bottom5_actual=float(wk.filter(pl.col("r") > pl.col("r").max().over("week") - 5)["dk"].mean()),
        all_actual=float(y.mean()),
        components={
            s: dict(model=float(np.abs(pred[f"proj_{s}"].to_numpy() - pred[s].to_numpy()).mean()),
                    recent_avg=float(np.abs(pred[f"def_{s}_l"].to_numpy() - pred[s].to_numpy()).mean()))
            for s in ("sacks", "interceptions", "fumble_recoveries", "tds", "points_allowed")
        },
        oof_mae=model.oof_mae,
    )


def to_markdown(r: dict) -> str:
    c = r["components"]
    lines = [
        "## Team defense (DST) — DraftKings points",
        "",
        f"{r['n']} team-games. DST scoring is mostly noise, so the bar is ranking defenses better than their own recent average does.",
        "",
        "| | MAE | Rank corr |",
        "|---|---|---|",
        f"| Model | {r['model_mae']:.2f} | {r['rank_model']:.3f} |",
        f"| Defense's recent average | {r['recent_avg_mae']:.2f} | {r['rank_recent_avg']:.3f} |",
        f"| Last 4 games | {r['last4_mae']:.2f} | |",
        f"| League average for everyone | {r['league_avg_mae']:.2f} | |",
        "",
        f"Each week's five highest-projected defenses averaged **{r['top5_actual']:.1f}** DK points, the five lowest "
        f"**{r['bottom5_actual']:.1f}**, all defenses {r['all_actual']:.1f}. "
        f"The 80% band covered {r['cover_p10_p90']:.0%} of outcomes; bias {r['bias']:+.2f}.",
        "",
        "| Component | Model MAE | Recent avg MAE |",
        "|---|---|---|",
        *[f"| {k.replace('_', ' ')} | {v['model']:.3f} | {v['recent_avg']:.3f} |" for k, v in c.items()],
        "",
    ]
    return "\n".join(lines)
