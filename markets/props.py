"""Player props: from provider rows to comparable, gradeable prices.

A prop in bsb.odds_snapshots is a provider market name ("over_under_player_
receiving_yards_(incl._overtime)"), a player written "Last, First", an outcome
("over" / "under" / "40+") and a price. This module

  1. maps the market to one of our stats and a numeric line ("40+" → over 39.5),
  2. matches the player to our player_id (within the two teams in that game),
  3. pairs over/under at the same book and line and strips the vig,
  4. asks the projection model for its probability of the over,

so each row answers: what does the book charge, what does the sharpest book
(Pinnacle) think is fair, and what does our model think.

Only markets whose provider name carries "(incl. overtime)" are used — the
same names without it turned out to be different, mislabelled markets (e.g.
"receiving yards" lines of 4.5 for starting tight ends)."""

from __future__ import annotations

import logging
import re

import numpy as np
import polars as pl
from scipy import stats as sps

from model import train
from optimizer.slate import norm_name

log = logging.getLogger(__name__)

# provider market (after stripping over_under_ / _(incl._overtime)) → our stat
STAT_MAP = {
    "player_pass_yards": "passing_yards", "player_pass_attempts": "attempts",
    "player_pass_completions": "completions", "player_td_passes": "passing_tds",
    "player_interceptions": "interceptions",
    "player_rush_yards": "rushing_yards", "player_rush_attempts": "carries",
    "player_receiving_yards": "receiving_yards", "player_receptions": "receptions",
    "player_td": "anytime_td", "player_to_score_td": "anytime_td",
}
_SUFFIX = "_(incl._overtime)"
_MILESTONE = re.compile(r"^(\d+)\+$")
SHARP_BOOK = "pinnacle"
MAX_HOLD = 0.15   # a two-way market with more vig than this is stale or broken
# The provider labels whole-game props "result" (its "full" is used for game lines only);
# "p1", "p1+p2", "p3+p4+overtime" are quarter and half props, which we do not price.
# Filtering on "full" alone matched nothing, so no real prop was ever priced.
FULL_GAME_PERIODS = ("result", "full")


def canonical(prop_type: str | None, outcome: str | None, line: float | None) -> tuple[str, float, str] | None:
    """→ (stat, line, side) or None if the market isn't one we price.
    'over_under_player_receptions_(incl._overtime)', 'over', 3.5 → ('receptions', 3.5, 'over')
    'player_receiving_yards_(incl._overtime)', '40+', None      → ('receiving_yards', 39.5, 'over')"""
    if not prop_type or not prop_type.endswith(_SUFFIX):
        return None
    stat = STAT_MAP.get(prop_type.removesuffix(_SUFFIX).removeprefix("over_under_"))
    if stat is None or outcome is None:
        return None
    m = _MILESTONE.match(outcome)
    if m:
        return stat, float(m.group(1)) - 0.5, "over"
    if outcome in ("over", "under") and line is not None:
        return stat, float(line), outcome
    if stat == "anytime_td" and line is None and outcome in ("yes", "no"):   # "to score a touchdown": yes / no
        return stat, 0.5, "over" if outcome == "yes" else "under"
    return None


def player_key(provider_name: str | None) -> str | None:
    """'Beckham Jr., Odell' → 'odellbeckham' (same key as norm_name('Odell Beckham Jr.'))."""
    if not provider_name:
        return None
    last, _, first = provider_name.partition(",")
    return norm_name(f"{first.strip()} {last.strip()}" if first else last.strip())


def latest_rows(conn, game_ids: list[str], max_age_hours: int = 72) -> pl.DataFrame:
    """Prop rows from each bookmaker's most recent snapshot for these games."""
    cur = conn.execute(
        """with last as (
               select bookmaker, max(captured_at) as captured_at
               from bsb.odds_snapshots
               where market = 'player_prop' and game_id = any(%s)
                 and captured_at > now() - make_interval(hours => %s)
               group by bookmaker)
           select o.game_id, o.bookmaker, o.prop_type, o.outcome, o.line::float8, o.price_decimal::float8,
                  o.price_american, o.raw->>'playerName', o.captured_at
           from bsb.odds_snapshots o join last l using (bookmaker, captured_at)
           where o.market = 'player_prop' and o.period = any(%s) and o.game_id = any(%s)""",
        (game_ids, max_age_hours, list(FULL_GAME_PERIODS), game_ids),
    )
    cols = ["game_id", "bookmaker", "prop_type", "outcome", "line", "price_decimal", "price_american", "player_name", "captured_at"]
    return pl.DataFrame(cur.fetchall(), schema=cols, orient="row", infer_schema_length=None)


def tidy(rows: pl.DataFrame, players: pl.DataFrame) -> pl.DataFrame:
    """Raw prop rows → one row per (game, player, stat, line, book) with over and
    under prices side by side and the no-vig over probability where both exist.
    `players`: player_id, player_name, team, game_id (this week's projections)."""
    if rows.is_empty():
        return pl.DataFrame()
    canon = [canonical(p, o, ln) for p, o, ln in zip(rows["prop_type"], rows["outcome"], rows["line"], strict=True)]
    r = rows.with_columns(
        pl.Series("stat", [c[0] if c else None for c in canon], dtype=pl.Utf8),
        pl.Series("line", [c[1] if c else None for c in canon], dtype=pl.Float64),
        pl.Series("side", [c[2] if c else None for c in canon], dtype=pl.Utf8),
        pl.Series("key", [player_key(n) for n in rows["player_name"]], dtype=pl.Utf8),
    ).filter(pl.col("stat").is_not_null() & pl.col("key").is_not_null() & (pl.col("price_decimal") > 1))
    pk = players.with_columns(pl.col("player_name").map_elements(norm_name, return_dtype=pl.Utf8).alias("key")).select(
        "game_id", "key", "player_id", "team"
    ).unique(["game_id", "key"])
    r = r.join(pk, on=["game_id", "key"], how="inner")
    idx = ["game_id", "player_id", "team", "stat", "line", "bookmaker"]
    wide = r.group_by(idx).agg(
        pl.col("price_decimal").filter(pl.col("side") == "over").max().alias("over_decimal"),
        pl.col("price_decimal").filter(pl.col("side") == "under").max().alias("under_decimal"),
        pl.col("captured_at").max(),
    )
    io, iu = 1 / pl.col("over_decimal"), 1 / pl.col("under_decimal")
    return wide.with_columns((io + iu - 1).alias("hold")).with_columns(
        # no-vig probability only from a coherent two-way market
        pl.when(pl.col("hold").is_between(-0.005, MAX_HOLD)).then(io / (io + iu)).alias("novig_over")
    )


def _td_prob_over(model: train.Model, rush_mu: np.ndarray, rec_mu: np.ndarray, line: np.ndarray) -> np.ndarray:
    """P(rushing TDs + receiving TDs > line): convolve the two count distributions."""
    k = np.arange(0, 8)
    out = np.empty(len(line))
    for i in range(len(line)):
        nr, pr = model.dists["rushing_tds"]._np(np.array([rush_mu[i]]))
        nc, pc = model.dists["receiving_tds"]._np(np.array([rec_mu[i]]))
        total = np.convolve(sps.nbinom.pmf(k, nr[0], pr[0]), sps.nbinom.pmf(k, nc[0], pc[0]))
        out[i] = total[int(np.floor(line[i])) + 1:].sum()
    return out


def add_model(props: pl.DataFrame, model: train.Model, projections: pl.DataFrame) -> pl.DataFrame:
    """Attach the model's projected mean and P(over line) to each prop."""
    if props.is_empty():
        return props
    stats_ = [s for s in train.SPECS]
    p = props.join(projections.select("player_id", "position", *stats_), on="player_id", how="left")
    mean, prob = np.full(p.height, np.nan), np.full(p.height, np.nan)
    stat, pos, line = p["stat"].to_numpy(), p["position"].to_numpy(), p["line"].to_numpy()
    for s in set(stat):
        m = stat == s
        if s == "anytime_td":
            rush, rec = p["rushing_tds"].to_numpy()[m].astype(float), p["receiving_tds"].to_numpy()[m].astype(float)
            ok = ~np.isnan(rush)
            mu = rush + rec
            pr = np.full(m.sum(), np.nan)
            pr[ok] = _td_prob_over(model, rush[ok], rec[ok], line[m][ok])
        else:
            mu = p[s].to_numpy()[m].astype(float)
            ok = ~np.isnan(mu) & np.isin(pos[m], train.SPECS[s].positions)
            pr = np.full(m.sum(), np.nan)
            pr[ok] = train.prob_over(model, s, mu[ok], line[m][ok])
        mean[m], prob[m] = mu, pr
    out = p.drop(*stats_).with_columns(
        pl.Series("proj_mean", mean).fill_nan(None), pl.Series("model_over", prob).fill_nan(None)
    )
    return drop_implausible(out)


MAX_DISAGREEMENT = 0.40


def drop_implausible(props: pl.DataFrame) -> pl.DataFrame:
    """Remove prices that cannot be for the stat they are filed under. The feed
    mislabels some markets: BetMGM's 243.5 "rushing yards" line for a quarterback
    was his passing line. The model saying 0% where the book says 50% is not an
    edge, it is a different bet. Compared against the book's own probability
    (no-vig when both sides are quoted, else the price itself)."""
    if props.is_empty():
        return props
    over_implied = pl.coalesce(pl.col("novig_over"), 1 / pl.col("over_decimal"))
    under_implied = 1 / pl.col("under_decimal")
    gap = pl.coalesce(
        (pl.col("model_over") - over_implied).abs(),
        ((1 - pl.col("model_over")) - under_implied).abs(),
    )
    keep = props.filter(gap.is_null() | (gap <= MAX_DISAGREEMENT))
    if keep.height < props.height:
        log.info("props: dropped %d prices the model flatly contradicts (mislabelled markets)", props.height - keep.height)
    return keep


def write_db(conn, props: pl.DataFrame, run_id: int, season: int, week: int) -> int:
    from ingest.db import insert_df

    if props.is_empty():
        return 0
    df = props.drop("position", strict=False).with_columns(
        pl.lit(run_id).alias("run_id"), pl.lit(season).alias("season"), pl.lit(week).alias("week"),
    )
    n = insert_df(conn, "prop_prices", df)
    conn.commit()
    return n


def build(conn, model: train.Model, projections: pl.DataFrame, run_id: int, season: int, week: int) -> int:
    """Price every current prop for this week's projected players → bsb.prop_prices."""
    skill = projections.filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"]))
    games = skill["game_id"].drop_nulls().unique().to_list()
    rows = latest_rows(conn, games)
    props = add_model(tidy(rows, skill.select("player_id", "player_name", "team", "game_id")), model, skill)
    n = write_db(conn, props, run_id, season, week)
    log.info("props: %d raw rows → %d priced player-lines across %d games", rows.height, n, len(games))
    return n


def grade(props: pl.DataFrame) -> dict:
    """Score settled props (needs `actual`): is the model's probability closer to
    what happened than the sharp book's? And did the edges it flagged pay?"""
    p = props.filter(pl.col("actual").is_not_null() & pl.col("model_over").is_not_null())
    if p.is_empty():
        return {"n": 0}
    hit = (p["actual"] > p["line"]).cast(pl.Float64)
    p = p.with_columns(hit.alias("hit"))

    def ll(prob: pl.Series, y: pl.Series) -> float:
        q = prob.clip(0.01, 0.99).to_numpy()
        t = y.to_numpy()
        return float(-(t * np.log(q) + (1 - t) * np.log(1 - q)).mean())

    out: dict = {"n": p.height}
    sharp = p.filter((pl.col("bookmaker") == SHARP_BOOK) & pl.col("novig_over").is_not_null())
    if sharp.height:
        out["vs_pinnacle"] = dict(
            n=sharp.height, logloss_model=ll(sharp["model_over"], sharp["hit"]),
            logloss_pinnacle=ll(sharp["novig_over"], sharp["hit"]),
            brier_model=float(((sharp["model_over"] - sharp["hit"]) ** 2).mean()),
            brier_pinnacle=float(((sharp["novig_over"] - sharp["hit"]) ** 2).mean()),
        )
    # flat 1-unit bets on every side the model made ≥ +5% EV at the offered price
    bets = []
    for side, dec, prob, won in (
        ("over", "over_decimal", pl.col("model_over"), pl.col("hit")),
        ("under", "under_decimal", 1 - pl.col("model_over"), 1 - pl.col("hit")),
    ):
        b = p.filter(pl.col(dec).is_not_null() & (pl.col("bookmaker") != SHARP_BOOK)).with_columns(
            (prob * pl.col(dec) - 1).alias("ev"), won.alias("won")
        ).filter(pl.col("ev") >= 0.05).with_columns((pl.col("won") * pl.col(dec) - 1).alias("profit"), pl.lit(side).alias("side"))
        bets.append(b.select("player_id", "stat", "line", "bookmaker", "side", "ev", "won", "profit"))
    b = pl.concat(bets)
    if b.height:
        out["model_edges"] = dict(n=b.height, wins=int(b["won"].sum()), units=round(float(b["profit"].sum()), 2),
                                  roi=round(float(b["profit"].mean()), 4), avg_ev_claimed=round(float(b["ev"].mean()), 4))
    return out
