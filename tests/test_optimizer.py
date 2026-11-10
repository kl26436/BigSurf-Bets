"""Optimizer tests on a synthetic 3-game slate — no network, no database."""

from datetime import UTC, datetime, timedelta

import numpy as np
import polars as pl
import pytest

pytest.importorskip("scipy")

from optimizer import corr, portfolio, sim  # noqa: E402
from optimizer.classic import SALARY_CAP, Rules, Solver, assign_slots  # noqa: E402

GAMES = [("AAA", "BBB"), ("CCC", "DDD"), ("EEE", "FFF")]
DEPTH = {"QB": 2, "RB": 4, "WR": 6, "TE": 3, "DST": 1}
TOP = {"QB": 21.0, "RB": 17.0, "WR": 16.0, "TE": 11.0, "DST": 7.0}


def _pool(seed=0) -> pl.DataFrame:
    rng = np.random.default_rng(seed)
    rows, n = [], 0
    for g, (a, b) in enumerate(GAMES):
        for team, opp in ((a, b), (b, a)):
            for pos, depth in DEPTH.items():
                for k in range(depth):
                    mean = TOP[pos] * (0.62 ** k) * rng.uniform(0.85, 1.15)
                    n += 1
                    rows.append(dict(
                        dk_id=str(1000 + n), player_id=f"p{n}", name=f"{team} {pos}{k + 1}", pos=pos, team=team, opponent=opp,
                        game="-".join(sorted((team, opp))), kickoff=datetime(2026, 11, 15, 18, tzinfo=UTC) + timedelta(hours=3 * g),
                        salary=int(round((2200 + mean * 330 * rng.uniform(0.9, 1.1)) / 100) * 100), status=None,
                        dk_mean=mean, dk_std=mean * 0.5, dk_p10=mean * 0.35, dk_p25=mean * 0.6, dk_p50=mean * 0.93,
                        dk_p75=mean * 1.3, dk_p90=mean * 1.75,
                    ))
    return pl.DataFrame(rows)


@pytest.fixture(scope="module")
def pool() -> pl.DataFrame:
    return _pool()


def _legal(pool: pl.DataFrame, idx: np.ndarray, rules: Rules) -> None:
    p = pool[idx]
    c = dict(p.group_by("pos").len().iter_rows())
    assert p.height == 9 and c["QB"] == 1 and c["DST"] == 1
    assert 2 <= c["RB"] <= 3 and 3 <= c["WR"] <= 4 and 1 <= c["TE"] <= 2 and c["RB"] + c["WR"] + c["TE"] == 7
    assert rules.min_salary <= p["salary"].sum() <= SALARY_CAP
    assert p["game"].n_unique() >= 2
    assert [s for s, _ in assign_slots(pool, idx)] == ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]


def test_solver_is_legal_and_optimal(pool):
    mean = pool["dk_mean"].to_numpy()
    idx = Solver(pool).solve(mean)
    _legal(pool, idx, Rules())
    # no cheaper-or-equal single swap at the same position beats it
    sal, pos = pool["salary"].to_numpy(), pool["pos"].to_numpy()
    slack = SALARY_CAP - sal[idx].sum()
    for i in idx:
        better = (pos == pos[i]) & (mean > mean[i] + 1e-9) & (sal <= sal[i] + slack) & ~np.isin(np.arange(pool.height), idx)
        if better.any():  # only allowed if a strategy rule blocks it (offense vs own DST / team cap)
            j = np.flatnonzero(better)[0]
            dst_team = pool["team"][int(idx[pos[idx] == "DST"][0])]
            assert pool["opponent"][int(j)] == dst_team or pos[i] == "DST"


def test_strategy_rules(pool):
    mean = pool["dk_mean"].to_numpy()
    r = Rules(qb_stack=2, bring_back=1)
    idx = Solver(pool, r).solve(mean)
    _legal(pool, idx, r)
    p = pool[idx]
    qb = p.filter(pl.col("pos") == "QB").row(0, named=True)
    assert p.filter((pl.col("team") == qb["team"]) & pl.col("pos").is_in(["WR", "TE"])).height >= 2
    assert p.filter((pl.col("team") == qb["opponent"]) & pl.col("pos").is_in(["RB", "WR", "TE"])).height >= 1
    dst = p.filter(pl.col("pos") == "DST").row(0, named=True)
    assert p.filter((pl.col("opponent") == dst["team"]) & (pl.col("pos") != "DST")).height == 0

    worst_qb = pool.filter(pl.col("pos") == "QB").sort("dk_mean")["dk_id"][0]
    star = pool.sort("dk_mean", descending=True)["dk_id"][0]
    idx = Solver(pool, Rules(lock={worst_qb}, exclude={star})).solve(mean)
    chosen = set(pool[idx]["dk_id"])
    assert worst_qb in chosen and star not in chosen


def test_simulation_marginals_and_correlation(pool):
    S = sim.simulate(pool, n_sims=20_000, seed=1)
    mean = pool["dk_mean"].to_numpy()
    assert np.abs(S.mean(0) - mean).max() < 0.35            # each player's simulated mean ≈ projection
    np.testing.assert_allclose(np.median(S, axis=0), pool["dk_p50"].to_numpy(), rtol=0.06, atol=0.3)
    at = lambda name: pool["name"].to_list().index(name)      # noqa: E731
    c = lambda a, b: np.corrcoef(S[:, at(a)], S[:, at(b)])[0, 1]  # noqa: E731
    assert c("AAA QB1", "AAA WR1") > 0.2                     # QB lifts his WR1
    assert c("AAA QB1", "BBB DST1") < -0.15                  # and sinks the defense facing him
    assert abs(c("AAA QB1", "CCC WR1")) < 0.05               # different games are independent


def test_role_matrix_is_valid():
    M = corr.game_matrix(corr.load())
    assert M.shape == (16, 16) and np.allclose(M, M.T) and np.allclose(np.diag(M), 1)
    assert np.linalg.eigvalsh(M).min() > 0


@pytest.mark.parametrize("mode", ["gpp", "cash"])
def test_portfolio_respects_exposure_and_uniqueness(pool, mode):
    st = portfolio.Settings(n=8, mode=mode, max_exposure=0.5, min_unique=3, candidates=4, n_sims=2000)
    pf = portfolio.build(pool, st)
    assert len(pf.lineups) == 8
    for idx in pf.lineups:
        _legal(pool, idx, st.resolved_rules())
    sets = [set(i) for i in pf.lineups]
    assert min(9 - len(a & b) for k, a in enumerate(sets) for b in sets[k + 1:]) >= 3
    assert pf.exposure()["lineups"].max() <= 4
    if mode == "gpp":   # every tournament lineup pairs its QB with a pass catcher
        r = pf.rows()
        qb = r.filter(pl.col("slot") == "QB").select("lineup", pl.col("team").alias("qb_team"))
        stacked = r.join(qb, on="lineup").filter((pl.col("team") == pl.col("qb_team")) & pl.col("pos").is_in(["WR", "TE"]))
        assert stacked["lineup"].n_unique() == 8
    lines = pf.to_dk_csv().strip().splitlines()
    assert lines[0] == "QB,RB,RB,WR,WR,WR,TE,FLEX,DST" and len(lines) == 9
    assert all(len(ln.split(",")) == 9 for ln in lines[1:])
    assert pf.summary()["best_of_set_pct"].sum() == pytest.approx(100, abs=1.0)


def test_exposure_limits_that_cannot_be_met_stop_cleanly(pool):
    # 1 DST per lineup, 6 DSTs, cap of 1 lineup each → at most 6 lineups
    pf = portfolio.build(pool, portfolio.Settings(n=10, mode="cash", max_exposure=0.1, candidates=2, n_sims=500))
    assert len(pf.lineups) == 6 and pf.notes
