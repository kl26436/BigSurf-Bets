"""Vacated carries: when a team's running backs are projected for far fewer
carries than the team actually hands its backs, give the backs who are left
the difference.

Why this exists (week 10, 2026): Kansas City's starter was ruled out on
Saturday. He had been projected for 19.5 carries. The model moved his backup
from 4 carries to 12 — and the other 8 simply vanished from the team. The
backup carried 22 times for 38.1 DraftKings points at $4,700, in 56% of
tournament lineups and none of ours.

The model has "missing teammate" features, but it under-reacts in exactly the
rare weeks they matter most. Out of sample (2025 and 2026 weeks 1–10, trained
on 2019–2024): in the 49 team-weeks where the projected carries of the active
backs summed to under 80% of the team's recent running-back carries, the team
still ran its backs for about 90% of that recent figure. The lead back left was
under-projected by 2.2 DK points and beat the model's 90th percentile 14% of
the time (9.5% for all backs).

The rule: below TRIGGER × recent, lift the team's backs to TARGET × recent. The
extra goes mostly to whoever already leads (weights ∝ projected carries²): in
practice one back takes over, the work is not shared out evenly. Rushing
yards, rushing TDs, DK/PPR points and their ranges move with the carries.

What it buys, on the same out-of-sample weeks: the bias on the affected backs
goes from −0.98 to +0.02 DK points and carries MAE from 3.31 to 3.00. It does
NOT improve their DK error (4.28 → 4.30): which backup takes the work is still a
guess. It makes them fairly priced on average and gives them the ceiling they
really have, which is what a tournament lineup needs."""

from __future__ import annotations

import logging

import polars as pl

log = logging.getLogger(__name__)

TRIGGER = 0.80        # act when projected RB carries < this share of the team's recent RB carries
TARGET = 0.90         # … and lift them to this share
WINDOW = 6            # team games that make "recent"
MIN_GAMES = 3
CONCENTRATION = 2.0   # weights ∝ projected carries ** this
MAX_LIFT = 2.0        # no back's carries more than double
QS = ("p10", "p25", "p50", "p75", "p90")


def team_rb_carries(stats: pl.DataFrame, season: int, week: int) -> pl.DataFrame:
    """Each team's average running-back carries over its last WINDOW games
    before (season, week). → team, rb_carries_recent"""
    past = stats.filter(
        (pl.col("position_group") == "RB")
        & ((pl.col("season") < season) | ((pl.col("season") == season) & (pl.col("week") < week)))
        & (pl.col("season") >= season - 1)
    )
    games = past.group_by("team", "season", "week").agg(pl.col("carries").sum().alias("c")).sort("season", "week")
    return (
        games.group_by("team", maintain_order=True).tail(WINDOW)
        .group_by("team").agg(pl.col("c").mean().alias("rb_carries_recent"), pl.len().alias("n"))
        .filter(pl.col("n") >= MIN_GAMES).drop("n")
    )


def lifts(proj: pl.DataFrame, recent: pl.DataFrame) -> pl.DataFrame:
    """→ player_id, lift (> 1) for the backs whose team is short of carries."""
    rb = proj.filter((pl.col("position") == "RB") & pl.col("carries").is_not_null()).join(recent, on="team")
    if rb.is_empty():
        return pl.DataFrame(schema={"player_id": pl.Utf8, "team": pl.Utf8, "lift": pl.Float64})
    w = pl.col("carries").clip(0, None) ** CONCENTRATION
    rb = rb.with_columns(pl.col("carries").sum().over("team").alias("_sum")).with_columns(
        pl.when(pl.col("_sum") < TRIGGER * pl.col("rb_carries_recent"))
        .then(TARGET * pl.col("rb_carries_recent") - pl.col("_sum")).otherwise(0.0).alias("_gap"),
        (w / pl.max_horizontal(w.sum().over("team"), pl.lit(1e-9))).alias("_w"),
    ).with_columns(
        ((pl.col("carries") + pl.col("_gap") * pl.col("_w")) / pl.max_horizontal(pl.col("carries"), pl.lit(0.5)))
        .clip(1.0, MAX_LIFT).alias("lift")
    )
    return rb.filter(pl.col("lift") > 1.02).select("player_id", "team", "lift")


def apply(proj: pl.DataFrame, stats: pl.DataFrame, season: int, week: int) -> tuple[pl.DataFrame, list[dict]]:
    """Projections with vacated carries handed to the backs who are left.
    → (projections, what was changed: [{player, team, lift, dk_before, dk_after}])"""
    need = {"position", "carries", "rushing_yards", "rushing_tds", "dk_mean", "team", "player_id"}
    if not need <= set(proj.columns):
        return proj, []
    lf = lifts(proj, team_rb_carries(stats, season, week))
    if lf.is_empty():
        return proj, []
    p = proj.join(lf.select("player_id", "lift"), on="player_id", how="left").with_columns(pl.col("lift").fill_null(1.0))
    # points from rushing, before the lift: 0.1 per yard, 6 per touchdown (the same on DK and PPR)
    rush = 0.1 * pl.col("rushing_yards") + 6 * pl.col("rushing_tds")
    add = (pl.col("lift") - 1) * rush
    out = p.with_columns(add.alias("_add"))
    cols = []
    for k in ("dk", "ppr"):
        if f"{k}_mean" not in out.columns:
            continue
        ratio = (pl.col(f"{k}_mean") + pl.col("_add")) / pl.max_horizontal(pl.col(f"{k}_mean"), pl.lit(0.5))
        cols += [(pl.col(f"{k}_mean") + pl.col("_add")).round(2).alias(f"{k}_mean")]
        cols += [(pl.col(c) * ratio).round(2).alias(c) for c in (f"{k}_std", *[f"{k}_{q}" for q in QS]) if c in out.columns]
    if "anytime_td_prob" in out.columns:
        tds = pl.col("rushing_tds") + pl.col("receiving_tds").fill_null(0.0) if "receiving_tds" in out.columns else pl.col("rushing_tds")
        grow = (tds + (pl.col("lift") - 1) * pl.col("rushing_tds")) / pl.max_horizontal(tds, pl.lit(1e-6))
        cols.append((1 - (1 - pl.col("anytime_td_prob")) ** grow).round(4).alias("anytime_td_prob"))
    out = out.with_columns(*cols).with_columns(
        *[(pl.col(c) * pl.col("lift")).round(3).alias(c) for c in ("carries", "rushing_yards", "rushing_tds")]
    )
    if "stat_quantiles" in out.columns:
        out = out.with_columns(_lift_quantiles(out))
    changed = (
        out.filter(pl.col("lift") > 1.0).join(proj.select("player_id", pl.col("dk_mean").alias("dk_before")), on="player_id")
        .select(pl.col("player_name").alias("player") if "player_name" in out.columns else pl.col("player_id").alias("player"),
                "team", pl.col("lift").round(2), "dk_before", pl.col("dk_mean").alias("dk_after"))
        .sort("dk_after", descending=True).to_dicts()
    )
    for c in changed:
        log.info("vacated carries: %s (%s) ×%.2f carries, %.1f → %.1f DK", c["player"], c["team"], c["lift"], c["dk_before"], c["dk_after"])
    return out.drop("lift", "_add").sort("dk_mean", descending=True), changed


def _lift_quantiles(df: pl.DataFrame) -> pl.Series:
    """The ranges shown for carries and rushing yards move with the lift."""
    rows = df["stat_quantiles"].to_list()
    lift = df["lift"].to_list()
    out = []
    for sq, f in zip(rows, lift, strict=True):
        if sq is None or f <= 1.0:
            out.append(sq)
            continue
        new = dict(sq)
        for stat in ("carries", "rushing_yards"):
            if isinstance(sq.get(stat), dict):
                new[stat] = {q: (None if v is None else round(v * f, 1)) for q, v in sq[stat].items()}
        out.append(new)
    return pl.Series("stat_quantiles", out, dtype=df.schema["stat_quantiles"])
