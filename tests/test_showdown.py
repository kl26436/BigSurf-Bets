"""Showdown (single game, captain) lineups on a synthetic slate, and kicker scoring — no network, no database."""

import numpy as np
import polars as pl
import pytest

pytest.importorskip("scipy")

from optimizer import portfolio, showdown  # noqa: E402

DEPTH = {"QB": [19, 2], "RB": [14, 8, 3], "WR": [15, 11, 7, 4], "TE": [9, 4], "K": [8.5], "DST": [6.5]}


def _pool(captains: bool = True) -> pl.DataFrame:
    rows, n = [], 1000
    for team, opp in (("AAA", "BBB"), ("BBB", "AAA")):
        for pos, means in DEPTH.items():
            for m in means:
                n += 1
                sal = int(round((m * 520 + 1500) / 200) * 200)
                base = dict(player_id=f"p{n}", name=f"{team} {pos} {n}", pos=pos, team=team, opponent=opp, game="AAA-BBB", kickoff=None,
                            status=None, dk_mean=float(m), dk_std=m * 0.5, dk_p10=m * 0.3, dk_p25=m * 0.6, dk_p50=m * 0.93,
                            dk_p75=m * 1.3, dk_p90=m * 1.8)
                rows.append({**base, "dk_id": str(n), "salary": sal})
                if captains:
                    rows.append({**base, "dk_id": f"{n}-CPT", "salary": int(sal * 1.5)})
    return pl.DataFrame(rows)


def _check_legal(p: pl.DataFrame, idx: np.ndarray, cap: int = 50_000) -> int:
    assert len(idx) == 6 and len(set(idx.tolist())) == 6
    salary = int(p["cpt_salary"][int(idx[0])]) + int(p["salary"].to_numpy()[idx[1:]].sum())
    assert salary <= cap
    assert set(p["team"].to_numpy()[idx]) == {"AAA", "BBB"}
    return salary


def test_two_rows_per_player_fold_into_one():
    p = showdown.players(_pool())
    assert p.height == 26 and p["dk_id"].str.ends_with("-CPT").sum() == 0
    assert (p["cpt_id"] == p["dk_id"] + "-CPT").all() and (p["cpt_salary"] == (p["salary"] * 1.5).cast(pl.Int64)).all()
    # an export with no captain rows: DraftKings' 1.5x rule fills them in
    q = showdown.players(_pool(captains=False))
    assert q.height == 26 and (q["cpt_salary"] == (q["salary"] * 1.5 / 100).round() * 100).all()


def test_best_lineup_is_legal_and_beats_every_other_captain():
    p = showdown.players(_pool())
    mean = p["dk_mean"].to_numpy()
    s = showdown.Solver(p)
    best = s.solve(mean)
    _check_legal(p, best)
    score = lambda i: 1.5 * mean[i[0]] + mean[i[1:]].sum()  # noqa: E731
    # the same six with any other of them as captain is no better (or is over the cap)
    for k in range(1, 6):
        alt = np.concatenate([[best[k]], np.delete(best, k)])
        over = int(p["cpt_salary"][int(alt[0])]) + int(p["salary"].to_numpy()[alt[1:]].sum()) > 50_000
        assert over or score(alt) <= score(best) + 1e-9
    # brute force over random legal lineups never finds a better one
    rng = np.random.default_rng(0)
    for _ in range(3000):
        idx = rng.choice(p.height, 6, replace=False)
        sal = int(p["cpt_salary"][int(idx[0])]) + int(p["salary"].to_numpy()[idx[1:]].sum())
        if sal <= 50_000 and len(set(p["team"].to_numpy()[idx])) == 2:
            assert score(idx) <= score(best) + 1e-9


def test_lock_exclude_and_captain_rules():
    p = showdown.players(_pool())
    k = p.filter(pl.col("pos") == "K")["dk_id"][0]
    star = p.sort("dk_mean", descending=True)["dk_id"][0]
    wr = p.filter(pl.col("pos") == "WR").sort("dk_mean", descending=True)
    s = showdown.Solver(p, showdown.Rules(lock={k}, exclude={star + "-CPT"}, captain={wr["dk_id"][0], wr["dk_id"][1]}))
    idx = s.solve(p["dk_mean"].to_numpy())
    ids = p["dk_id"].to_numpy()[idx]
    assert k in ids and star not in ids                      # locked by either id; excluded by the captain row's id
    assert ids[0] in (wr["dk_id"][0], wr["dk_id"][1])        # only the named players may be captain
    assert showdown.Solver(p, showdown.Rules(min_salary=50_001)).solve(p["dk_mean"].to_numpy()) is None


def test_set_respects_exposure_and_uniqueness_and_writes_the_upload_file():
    pf = showdown.build(_pool(), portfolio.Settings(n=8, mode="gpp", max_exposure=0.5, min_unique=2, n_sims=2000))
    assert len(pf.lineups) == 8 and pf.totals.shape == (2000, 8)
    for idx in pf.lineups:
        _check_legal(pf.pool, idx)
    e = pf.exposure()
    assert e["lineups"].max() <= 4 and (e["captain"] <= e["lineups"]).all()
    def spots(i):
        return {("C", int(i[0]))} | {("F", int(x)) for x in i[1:]}
    for a in range(8):
        for b in range(a):
            assert len(spots(pf.lineups[a]) & spots(pf.lineups[b])) <= 4       # differ in at least two spots
    rows, summ = pf.rows(), pf.summary()
    one = rows.filter(pl.col("lineup") == 1)
    assert one["slot"].to_list() == ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"]
    assert one["dk_id"][0].endswith("-CPT") and int(one["salary"].sum()) == int(summ["salary"][0]) <= 50_000
    assert abs(float(one["dk_mean"].sum()) - float(summ["proj"][0])) < 0.05
    csv = pf.to_dk_csv().splitlines()
    assert csv[0] == "CPT,FLEX,FLEX,FLEX,FLEX,FLEX" and len(csv) == 9 and "-CPT" not in csv[1] and len(csv[1].split(",")) == 6
    # cash picks the highest expected lineup first
    cash = showdown.build(_pool(), portfolio.Settings(n=1, mode="cash", n_sims=1000))
    best = showdown.Solver(cash.pool).solve(cash.pool["dk_mean"].to_numpy())
    mean = cash.pool["dk_mean"].to_numpy()
    total = lambda i: 1.5 * mean[i[0]] + mean[i[1:]].sum()  # noqa: E731
    assert total(cash.lineups[0]) >= 0.98 * total(best)             # ties and simulation noise aside, the best on paper


def test_one_team_or_too_few_players_stops_cleanly():
    few = _pool().filter(pl.col("team") == "AAA").head(8)
    pf = showdown.build(few, portfolio.Settings(n=2, n_sims=500))
    assert pf.lineups == [] and pf.notes


def test_kicker_scoring_and_kickers_carry_to_the_next_game():
    from model import kicker
    from model.data import NFLData

    stats = pl.DataFrame({
        "season": [2026, 2026, 2026], "week": [1, 1, 2], "team": ["AAA", "BBB", "AAA"], "position": ["K", "K", "K"],
        "player_id": ["k1", "k2", "k1"], "player_display_name": ["Kick One", "Kick Two", "Kick One"],
        "fg_att": [3, 1, 2], "pat_att": [2, 4, 1], "pat_made": [2, 4, 1],
        "fg_made_0_19": [0, 0, 0], "fg_made_20_29": [1, 0, 0], "fg_made_30_39": [0, 0, 1], "fg_made_40_49": [1, 1, 0],
        "fg_made_50_59": [1, 0, 0], "fg_made_60_": [0, 0, 1],
    })
    assert stats.select(kicker.dk_points().alias("dk"))["dk"].to_list() == [2 + 3 + 4 + 5, 4 + 4, 1 + 3 + 5]
    sched = pl.DataFrame({
        "game_id": ["g1", "g2", "g3"], "season": [2026] * 3, "week": [1, 2, 3], "game_type": ["REG"] * 3,
        "gameday": ["2026-09-13", "2026-09-20", "2026-09-27"], "home_team": ["AAA", "AAA", "BBB"], "away_team": ["BBB", "CCC", "AAA"],
        "home_score": [27, 20, None], "away_score": [17, 13, None], "spread_line": [3.0, 2.5, -1.0], "total_line": [45.0, 41.0, 44.0],
        "roof": ["outdoors", "dome", "outdoors"], "home_qb_id": ["q"] * 3, "away_qb_id": ["q"] * 3,
    })
    d = NFLData(stats=stats, schedules=sched, injuries=pl.DataFrame(), snaps=pl.DataFrame(), players=pl.DataFrame())
    up = kicker.build(d, upcoming=(2026, 3))
    fut = up.filter(pl.col("is_future")).sort("team")
    assert fut["team"].to_list() == ["AAA", "BBB"] and fut["kicker_id"].to_list() == ["k1", "k2"]
    assert fut["dk"].null_count() == 2                                   # nothing from the game being projected
    a = up.filter((pl.col("team") == "AAA") & pl.col("is_future"))
    assert 9 <= a["k_dk_s"][0] <= 14                                      # his earlier games only
    played_ccc = up.filter((pl.col("team") == "CCC") & ~pl.col("is_future"))
    assert played_ccc["dk"].to_list() == [0.0]                            # a team that attempted no kick scored zero
    out = kicker.build(d, upcoming=(2026, 3), out_ids={"k1"}).filter(pl.col("is_future")).sort("team")
    assert out["kicker_id"].to_list() == [None, "k2"]                     # a kicker ruled out is not projected
