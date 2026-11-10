"""Market tools: prop canonicalisation, de-vigging, line shopping, grading."""

from datetime import UTC, datetime

import numpy as np
import polars as pl
import pytest

pytest.importorskip("lightgbm")

from markets import lines, props  # noqa: E402
from model import scorecard  # noqa: E402

OT = "_(incl._overtime)"
NOW = datetime(2026, 11, 14, 3, tzinfo=UTC)


def test_canonical_prop_markets():
    assert props.canonical(f"over_under_player_receptions{OT}", "over", 3.5) == ("receptions", 3.5, "over")
    assert props.canonical(f"over_under_player_pass_yards{OT}", "under", 249.5) == ("passing_yards", 249.5, "under")
    assert props.canonical(f"player_receiving_yards{OT}", "40+", None) == ("receiving_yards", 39.5, "over")
    assert props.canonical(f"player_to_score_td{OT}", "2+", None) == ("anytime_td", 1.5, "over")
    assert props.canonical(f"over_under_player_td{OT}", "under", 0.5) == ("anytime_td", 0.5, "under")
    # same name without the overtime suffix is a different (mislabelled) market — never priced
    assert props.canonical("over_under_player_receiving_yards", "over", 4.5) is None
    assert props.canonical(f"player_to_score_first_td{OT}", "1+", None) is None
    assert props.canonical(f"over_under_player_tackles_+_assists{OT}", "over", 5.5) is None


def test_player_key_matches_our_names():
    from optimizer.slate import norm_name

    for provider, ours in [("Hockenson, T.J.", "T.J. Hockenson"), ("Beckham Jr., Odell", "Odell Beckham Jr."),
                           ("Moore, DJ", "D.J. Moore"), ("St. Brown, Amon-Ra", "Amon-Ra St. Brown"), ("Cook, James", "James Cook III")]:
        assert props.player_key(provider) == norm_name(ours)


def _prop(book, name, ptype, outcome, line, dec, game="G1"):
    return dict(game_id=game, bookmaker=book, prop_type=ptype, outcome=outcome, line=line, price_decimal=dec,
                price_american=None, player_name=name, captured_at=NOW)


def test_tidy_pairs_sides_and_strips_vig():
    rows = pl.DataFrame([
        _prop("pinnacle", "Cook, James", f"over_under_player_rush_yards{OT}", "over", 74.5, 1.90),
        _prop("pinnacle", "Cook, James", f"over_under_player_rush_yards{OT}", "under", 74.5, 1.95),
        _prop("draftkings", "Cook, James", f"over_under_player_rush_yards{OT}", "over", 74.5, 2.05),
        _prop("draftkings", "Cook, James", f"over_under_player_rush_yards{OT}", "under", 74.5, 1.80),
        _prop("draftkings", "Cook, James", f"player_rush_yards{OT}", "100+", None, 3.6),       # one-sided milestone
        _prop("betmgm", "Cook, James", f"over_under_player_rush_yards{OT}", "over", 74.5, 1.9),
        _prop("betmgm", "Cook, James", f"over_under_player_rush_yards{OT}", "under", 74.5, 9.0),  # incoherent pair
        _prop("draftkings", "Nobody, Joe", f"over_under_player_rush_yards{OT}", "over", 10.5, 1.9),   # not our player
        _prop("draftkings", "Cook, James", "over_under_player_rush_yards", "over", 4.5, 1.9),          # mislabelled market
    ], infer_schema_length=None)
    players = pl.DataFrame({"player_id": ["p1"], "player_name": ["James Cook III"], "team": ["BUF"], "game_id": ["G1"]})
    t = props.tidy(rows, players)
    assert t.height == 4 and set(t["player_id"]) == {"p1"}
    pin = t.filter(pl.col("bookmaker") == "pinnacle").row(0, named=True)
    assert pin["novig_over"] == pytest.approx((1 / 1.90) / (1 / 1.90 + 1 / 1.95))
    assert pin["hold"] == pytest.approx(1 / 1.90 + 1 / 1.95 - 1)
    mile = t.filter(pl.col("line") == 99.5).row(0, named=True)
    assert mile["over_decimal"] == 3.6 and mile["under_decimal"] is None and mile["novig_over"] is None
    assert t.filter(pl.col("bookmaker") == "betmgm")["novig_over"][0] is None   # −5% "hold": not a real market


def test_grade_compares_model_with_pinnacle_and_settles_edges():
    rng = np.random.default_rng(0)
    n = 400
    truth = rng.uniform(0.25, 0.75, n)
    hit = rng.random(n) < truth
    base = dict(stat=["receiving_yards"] * n, line=[49.5] * n, actual=np.where(hit, 60.0, 40.0),
                player_id=[f"p{i}" for i in range(n)])
    sharp = pl.DataFrame({**base, "bookmaker": ["pinnacle"] * n, "over_decimal": [1.9] * n, "under_decimal": [1.9] * n,
                          "novig_over": np.full(n, 0.5), "model_over": truth})
    soft = sharp.with_columns(pl.lit("draftkings").alias("bookmaker"), pl.lit(2.0).alias("over_decimal"), pl.lit(2.0).alias("under_decimal"))
    g = props.grade(pl.concat([sharp, soft]))
    v = g["vs_pinnacle"]
    assert v["n"] == n and v["logloss_model"] < v["logloss_pinnacle"]      # the model here *is* the truth
    e = g["model_edges"]
    assert e["n"] > 100 and e["roi"] > 0 and abs(e["roi"] - e["avg_ev_claimed"]) < 0.12
    assert props.grade(sharp.with_columns(pl.lit(None, pl.Float64).alias("actual")))["n"] == 0


def _q(book, market, outcome, line, american, game="G1"):
    dec = 1 + american / 100 if american > 0 else 1 + 100 / abs(american)
    return dict(game_id=game, season=2026, week=10, bookmaker=book, market=market, outcome=outcome, line=line,
                price_decimal=dec, price_american=american, captured_at=NOW)


def test_lines_fair_value_best_price_and_arbitrage():
    rows = pl.DataFrame([
        _q("pinnacle", "total", "over", 44.0, -108), _q("pinnacle", "total", "under", 44.0, -108),
        _q("draftkings", "total", "over", 44.0, +105), _q("draftkings", "total", "under", 44.0, -125),
        _q("betmgm", "total", "over", 44.0, -125), _q("betmgm", "total", "under", 44.0, +104),
        _q("pinnacle", "spread", "home", -3.0, -105), _q("pinnacle", "spread", "away", 3.0, -111),
        _q("fanduel", "spread", "home", -3.0, -110), _q("fanduel", "spread", "away", 3.0, -110),
        _q("circa", "spread", "home", -3.5, +100), _q("circa", "spread", "away", 3.5, -120),      # different number: own market
        # garbage seen in the real feed: favourite −175 against +14400 — must not become an "arbitrage"
        _q("caesars", "moneyline", "away", None, -175), _q("caesars", "moneyline", "home", None, 14400),
        _q("pinnacle", "moneyline", "away", None, -176), _q("pinnacle", "moneyline", "home", None, 150),
    ], infer_schema_length=None)
    q = lines.analyse(rows)
    assert "caesars" not in q["bookmaker"].to_list()
    tot = q.filter(pl.col("market") == "total")
    assert tot["arb_pct"][0] == pytest.approx(1 / (1 / 2.05 + 1 / 2.04) - 1) and tot["arb_pct"][0] > 0
    dk_over = tot.filter((pl.col("bookmaker") == "draftkings") & (pl.col("outcome") == "over")).row(0, named=True)
    assert dk_over["fair_prob"] == pytest.approx(0.5) and dk_over["ev"] == pytest.approx(0.025) and dk_over["is_best"]
    sp = q.filter((pl.col("market") == "spread") & (pl.col("number") == -3.0))
    assert sp["arb_pct"][0] < 0 and sp.filter(pl.col("bookmaker") == "fanduel")["ev"].max() < 0
    assert q.filter(pl.col("number") == -3.5)["fair_prob"].null_count() == 2      # Pinnacle has no quote at −3.5
    assert q.filter(pl.col("market") == "moneyline")["arb_pct"][0] < 0


def test_scorecard_metrics():
    proj = pl.DataFrame({
        "player_id": ["a", "b", "c", "d", "DST_X", "e"], "position": ["QB", "RB", "WR", "WR", "DST", "TE"],
        "dk_mean": [20.0, 15.0, 12.0, 3.0, 7.0, 9.0], "dk_p10": [10.0, 6.0, 4.0, 0.0, 1.0, 2.0],
        "dk_p90": [32.0, 26.0, 22.0, 8.0, 15.0, 18.0], "ppr_mean": [19.0, 14.0, 11.0, 3.0, None, 8.0],
        "run_id": [1] * 6, "pre_kickoff": [True] * 6,
    })
    act = pl.DataFrame({"player_id": ["a", "b", "c", "d", "DST_X"], "dk": [24.0, 5.0, 12.5, 30.0, 16.0]})   # e did not play
    m = scorecard.projection_metrics(proj, act, pl.DataFrame({"player_id": ["a", "b", "c"], "dk_avg": [18.0, 16.0, 11.0]}))
    assert m["n_projected"] == 5 and m["n_played"] == 4 and m["did_not_play"] == 1    # d (3.0 projected) is below the bar
    assert m["by_position"]["ALL"]["mae"] == pytest.approx((4 + 10 + 0.5 + 9) / 4)
    assert m["by_position"]["RB"]["cover_p10_p90"] == 0.0 and m["by_position"]["DST"]["cover_p10_p90"] == 0.0

    lu = pl.DataFrame({
        "set_id": [1, 1, 1], "mode": ["gpp"] * 3, "lineup_no": [1, 2, 3], "actual": [150.0, 95.0, None],
        "p10": [100.0, 100.0, 100.0], "p50": [130.0] * 3, "p90": [165.0] * 3, "sim_mean": [131.0] * 3, "complete": [True, True, False],
    })
    s = scorecard.lineup_metrics(lu)[0]
    assert s["n"] == 3 and s["n_complete"] == 2 and s["best_actual"] == 150.0 and s["below_p10"] == 1 and s["in_p10_p90"] == 0.5
