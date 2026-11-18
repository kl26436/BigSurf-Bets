"""Vacated carries: a team's rushing work goes to the backs who are left."""

import polars as pl
import pytest

from model import volume


def _stats(team_carries: dict[str, list[int]]) -> pl.DataFrame:
    rows = []
    for team, games in team_carries.items():
        for wk, c in enumerate(games, 1):
            rows.append(dict(team=team, season=2026, week=wk, position_group="RB", carries=c - 4))
            rows.append(dict(team=team, season=2026, week=wk, position_group="RB", carries=4))
            rows.append(dict(team=team, season=2026, week=wk, position_group="QB", carries=5))   # not a back: ignored
    return pl.DataFrame(rows)


def _proj(rows: list[tuple]) -> pl.DataFrame:
    quant = {"carries": {"p10": 4.0, "p50": 10.0, "p90": 18.0}, "rushing_yards": {"p10": 15.0, "p50": 40.0, "p90": 80.0}}
    return pl.DataFrame([dict(
        player_id=pid, player_name=pid, position=pos, team=team, carries=c, rushing_yards=c * 4.0, rushing_tds=c * 0.03,
        receiving_tds=0.1, dk_mean=dk, dk_std=dk * 0.6, dk_p10=dk * 0.3, dk_p25=dk * 0.55, dk_p50=dk * 0.9, dk_p75=dk * 1.35,
        dk_p90=dk * 1.85, ppr_mean=dk - 0.5, ppr_std=dk * 0.6, ppr_p10=dk * 0.3, ppr_p25=dk * 0.5, ppr_p50=dk * 0.9, ppr_p75=dk * 1.3,
        ppr_p90=dk * 1.8, anytime_td_prob=0.3, stat_quantiles=quant) for pid, pos, team, c, dk in rows])


STATS = _stats({"KC": [22, 21, 24, 20, 23, 21], "BUF": [25, 26, 24, 27, 25, 26], "NEW": [20, 20]})


def test_recent_rb_carries_use_the_last_six_games_and_skip_thin_history():
    recent = dict(volume.team_rb_carries(STATS, 2026, 7).iter_rows())
    assert recent["KC"] == pytest.approx(21.833, abs=0.01) and recent["BUF"] == pytest.approx(25.5)
    assert "NEW" not in recent                                     # two games is not a pattern
    assert volume.team_rb_carries(STATS, 2026, 3)["team"].to_list() == []   # nothing before week 3 worth trusting


def test_the_backup_inherits_the_starters_carries():
    """Week 10 2026: the starter is out and the model gives the back who is left 12 carries of a usual 22."""
    proj = _proj([("johnson", "RB", "KC", 12.3, 11.92), ("fullback", "RB", "KC", 0.2, 0.6), ("mahomes", "QB", "KC", 3.0, 21.0),
                  ("cook", "RB", "BUF", 18.0, 19.5), ("davis", "RB", "BUF", 6.0, 6.0)])
    out, changed = volume.apply(proj, STATS, 2026, 7)
    by = {r["player_id"]: r for r in out.iter_rows(named=True)}
    j = by["johnson"]
    assert j["carries"] == pytest.approx(0.9 * 21.833 - 0.2, abs=0.05)   # the team reaches 90% of its usual 21.8; the lead back takes the gap
    assert j["rushing_yards"] == pytest.approx(j["carries"] * 4.0, abs=0.1)
    lift = j["carries"] / 12.3
    rush_points = 0.1 * 12.3 * 4.0 + 6 * 12.3 * 0.03
    assert j["dk_mean"] == pytest.approx(11.92 + (lift - 1) * rush_points, abs=0.02)
    assert j["dk_p90"] == pytest.approx(11.92 * 1.85 * j["dk_mean"] / 11.92, abs=0.05)   # the range moves with the mean
    assert j["anytime_td_prob"] > 0.3
    assert j["stat_quantiles"]["carries"]["p90"] == pytest.approx(18.0 * lift, abs=0.1)
    # nobody else moves: the quarterback, and a team whose backs already have their usual work
    for pid in ("mahomes", "cook", "davis"):
        before = proj.filter(pl.col("player_id") == pid).row(0, named=True)
        assert by[pid]["carries"] == before["carries"] and by[pid]["dk_mean"] == before["dk_mean"]
    assert [c["player"] for c in changed] == ["johnson"] and changed[0]["dk_before"] == 11.92
    assert out.columns == proj.columns and out.height == proj.height


def test_no_back_more_than_doubles_and_a_small_shortfall_is_left_alone():
    thin = _proj([("solo", "RB", "KC", 5.0, 5.0)])
    out, _ = volume.apply(thin, STATS, 2026, 7)
    assert out["carries"][0] == pytest.approx(10.0)                # capped at twice his own
    fine = _proj([("a", "RB", "KC", 13.0, 13.0), ("b", "RB", "KC", 5.0, 5.0)])   # 18 of 21.8 = 82%: above the trigger
    out, changed = volume.apply(fine, STATS, 2026, 7)
    assert changed == [] and out["carries"].to_list() == [13.0, 5.0]


def test_projections_without_the_columns_pass_through():
    dst = pl.DataFrame({"player_id": ["DST_KC"], "team": ["KC"], "dk_mean": [7.0]})
    out, changed = volume.apply(dst, STATS, 2026, 7)
    assert out.equals(dst) and changed == []


def test_a_run_with_lifted_backs_can_be_recorded():
    """The run's metrics are stored as JSON: numbers rounded, the list of lifted backs kept whole.
    (The first live run after this shipped failed here: every value was passed through float().)"""
    import json

    import numpy as np

    from model import project

    proj = _proj([("johnson", "RB", "KC", 12.3, 11.92)])
    _, changed = volume.apply(proj, STATS, 2026, 7)
    out = json.loads(project._json({"oof_mae_dk": np.float64(5.123456), "n": 3, "vacated_carries": changed}))
    assert out["oof_mae_dk"] == 5.1235 and out["n"] == 3.0
    assert out["vacated_carries"][0]["player"] == "johnson" and out["vacated_carries"][0]["dk_before"] == 11.92
