"""Regression tests for defects found in the November 2026 quality review."""

from __future__ import annotations

from datetime import date

import polars as pl

from ingest.odds_oddslink import _iter_prices, to_decimal
from ingest.sleeper import norm_name
from model import data
from optimizer.slate import apply_overrides


def _sched() -> pl.DataFrame:
    # week 10: Thursday game final, Sunday and Monday games still to play; week 11 untouched
    rows = [
        (2026, 10, "2026-11-12", "NYG", "WAS", 24),
        (2026, 10, "2026-11-15", "DET", "NE", None),
        (2026, 10, "2026-11-16", "BAL", "LAC", None),
        (2026, 11, "2026-11-19", "DAL", "PHI", None),
        (2026, 11, "2026-11-22", "KC", "BUF", None),
    ]
    return pl.DataFrame(rows, schema=["season", "week", "gameday", "home_team", "away_team", "home_score"], orient="row")


def test_week_in_play_stays_put_after_thursday_night():
    s = _sched()
    # the old rule ("first week with no game played") jumped to week 11 here, so the
    # Friday, Saturday and Sunday-morning runs never re-projected the Sunday slate
    assert data.next_week(s, 2026, today=date(2026, 11, 13)) == 10
    assert data.next_week(s, 2026, today=date(2026, 11, 15)) == 10
    assert data.next_week(s, 2026, today=date(2026, 11, 16)) == 10      # Monday: one game left
    assert data.open_teams(s, 2026, 10, today=date(2026, 11, 15)) == {"DET", "NE", "BAL", "LAC"}
    assert data.open_teams(s, 2026, 10, today=date(2026, 11, 16)) == {"BAL", "LAC"}


def test_week_rolls_over_on_tuesday_even_if_a_score_is_late():
    s = _sched()     # Monday's score has not reached nflverse yet
    assert data.next_week(s, 2026, today=date(2026, 11, 17)) == 11
    assert data.next_week(s, 2026, today=date(2027, 2, 20)) is None


def test_oddslink_american_prices_both_signs():
    assert to_decimal(-110) == 1 + 100 / 110
    assert to_decimal(145) == 2.45            # was stored as decimal 145.0
    assert to_decimal(100) == 2.0
    assert to_decimal(-175) == 1 + 100 / 175
    assert to_decimal(1.91) == 1.91           # a feed that already sends decimals is left alone
    assert to_decimal(1.0) is None and to_decimal(0) is None
    ev = {"home_team": "Dallas Cowboys", "away_team": "Philadelphia Eagles", "bookmakers": [{"key": "pinnacle", "markets": [
        {"key": "h2h", "outcomes": [{"name": "Dallas Cowboys", "price": 145}, {"name": "Philadelphia Eagles", "price": -175}]}]}]}
    got = {o: round(p, 4) for _b, _m, o, _l, p, _q in _iter_prices(ev)}
    assert got == {"home": 2.45, "away": round(1 + 100 / 175, 4)}
    assert 0 < sum(1 / p for p in got.values()) - 1 < 0.06      # a normal two-way market, not "garbage"


def test_name_keys_match_across_sources():
    assert norm_name("Marvin Harrison Jr.") == norm_name("marvin harrison") == "marvinharrison"
    assert norm_name("Amon-Ra St. Brown") == "amonrastbrown"
    assert norm_name("D'Andre Swift III") == "dandreswift"
    assert norm_name(None) == ""


def test_override_rescales_the_whole_distribution():
    df = pl.DataFrame({"dk_mean": [10.0, 8.0, None], "dk_std": [5.0, 4.0, None], "dk_p10": [2.0, 1.0, None],
                       "dk_p25": [5.0, 4.0, None], "dk_p50": [9.0, 7.0, None], "dk_p75": [14.0, 11.0, None],
                       "dk_p90": [20.0, 16.0, None], "override": [15.0, None, 12.0]})
    out = apply_overrides(df)
    assert out["dk_mean"].to_list() == [15.0, 8.0, None]         # no model number → an override alone does not create one
    assert out["dk_p90"].to_list()[:2] == [30.0, 16.0] and out["dk_std"].to_list()[:2] == [7.5, 4.0]
    assert "override" not in out.columns
