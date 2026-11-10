"""Game lines across sportsbooks: best price, fair value, +EV and arbitrage.

For every game and every market (moneyline, spread at a given number, total at
a given number) we line up each book's two-sided quote and compute

  fair_prob   the no-vig probability from Pinnacle's quote (the sharpest book)
  ev          what a $1 bet at this book's price returns on average if Pinnacle
              is right:  fair_prob × decimal_price − 1
  arb_pct     guaranteed return from backing both sides at the best available
              prices across books (positive = true arbitrage)

A quote is only trusted if the book's own two sides add up to a sane market
(vig between 0 and 12%). Feeds do carry garbage — e.g. a −175 favourite listed
against a +14400 underdog — and without this check every such row looks like a
huge "arbitrage"."""

from __future__ import annotations

import logging

import polars as pl

log = logging.getLogger(__name__)
SHARP_BOOK = "pinnacle"
MAX_HOLD = 0.12
PROVIDER = "oddslink"   # one call = all books' full-game lines, consistently labelled


def latest_rows(conn, max_age_hours: int = 36) -> pl.DataFrame:
    """Full-game lines from the newest snapshot, for games that haven't kicked off."""
    cur = conn.execute(
        """select o.game_id, g.season, g.week, o.bookmaker, o.market, o.outcome, o.line::float8,
                  o.price_decimal::float8, o.price_american, o.captured_at
           from bsb.odds_snapshots o join bsb.games g on g.game_id = o.game_id
           where o.provider = %s and o.period = 'full' and o.market in ('moneyline', 'spread', 'total')
             and o.captured_at = (select max(captured_at) from bsb.odds_snapshots where provider = %s)
             and o.captured_at > now() - make_interval(hours => %s)
             and g.kickoff_at > o.captured_at""",
        (PROVIDER, PROVIDER, max_age_hours),
    )
    cols = ["game_id", "season", "week", "bookmaker", "market", "outcome", "line", "price_decimal", "price_american", "captured_at"]
    return pl.DataFrame(cur.fetchall(), schema=cols, orient="row", infer_schema_length=None)


def analyse(rows: pl.DataFrame) -> pl.DataFrame:
    """One row per quote (game, market, number, side, book) with fair value, EV,
    best-price flag and the arbitrage return of its market."""
    if rows.is_empty():
        return pl.DataFrame()
    d = pl.col("price_decimal")
    r = rows.filter(d > 1).with_columns(
        # some feeds omit the American price; derive it so every quote has one
        pl.coalesce(
            pl.col("price_american"),
            pl.when(d >= 2).then(((d - 1) * 100).round()).otherwise((-100 / (d - 1)).round()).cast(pl.Int64),
        ).alias("price_american"),
        # a market key shared by both sides: spreads are quoted home −3 / away +3
        pl.when(pl.col("market") == "spread")
        .then(pl.when(pl.col("outcome") == "home").then(pl.col("line")).otherwise(-pl.col("line")))
        .when(pl.col("market") == "total").then(pl.col("line"))
        .otherwise(0.0).alias("number"),
    ).unique(["game_id", "bookmaker", "market", "number", "outcome"])
    mk = ["game_id", "market", "number"]
    # each book's own two-way market must be coherent before any of its prices are used
    book = r.group_by(*mk, "bookmaker").agg(
        pl.len().alias("_n"), (1 / pl.col("price_decimal")).sum().alias("_implied"),
    ).with_columns((pl.col("_implied") - 1).alias("hold"))
    r = r.join(book, on=[*mk, "bookmaker"]).filter((pl.col("_n") == 2) & pl.col("hold").is_between(-0.005, MAX_HOLD))
    sharp = r.filter(pl.col("bookmaker") == SHARP_BOOK).select(
        *mk, "outcome", ((1 / pl.col("price_decimal")) / pl.col("_implied")).alias("fair_prob")
    )
    best = r.group_by(*mk, "outcome").agg(pl.col("price_decimal").max().alias("best_decimal"))
    arb = best.group_by(mk).agg(
        pl.len().alias("_sides"), (1 / pl.col("best_decimal")).sum().alias("_best_implied")
    ).filter(pl.col("_sides") == 2).with_columns((1 / pl.col("_best_implied") - 1).alias("arb_pct"))
    out = (
        r.join(sharp, on=[*mk, "outcome"], how="left").join(best, on=[*mk, "outcome"]).join(arb.select(*mk, "arb_pct"), on=mk, how="left")
        .with_columns(
            (pl.col("fair_prob") * pl.col("price_decimal") - 1).alias("ev"),
            (pl.col("price_decimal") >= pl.col("best_decimal") - 1e-9).alias("is_best"),
        )
    )
    return out.select(
        "game_id", "season", "week", "market", "number", "outcome", "line", "bookmaker", "price_american",
        "price_decimal", "hold", "fair_prob", "ev", "is_best", "arb_pct", "captured_at",
    ).sort("game_id", "market", "number", "outcome", "price_decimal", descending=[False, False, False, False, True])


def build(conn) -> int:
    """Analyse the newest line snapshot → bsb.line_quotes (skips a snapshot already stored)."""
    from ingest.db import insert_df

    q = analyse(latest_rows(conn))
    if q.is_empty():
        log.info("lines: no fresh snapshot to analyse")
        return 0
    seen = conn.execute("select 1 from bsb.line_quotes where captured_at = %s limit 1", (q["captured_at"][0],)).fetchone()
    if seen:
        log.info("lines: snapshot %s already analysed", q["captured_at"][0])
        return 0
    n = insert_df(conn, "line_quotes", q)
    conn.commit()
    arbs = q.filter(pl.col("arb_pct") > 0).select("game_id", "market", "number").unique().height
    plus = q.filter((pl.col("ev") > 0.01) & (pl.col("bookmaker") != SHARP_BOOK)).height
    log.info("lines: %d quotes, %d arbitrage markets, %d quotes beating Pinnacle fair value by >1%%", n, arbs, plus)
    return n
