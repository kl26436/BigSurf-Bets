"""Guillotine league maths: lineups, the chop simulation, rival bids, the bid itself."""

from __future__ import annotations

import numpy as np

from league.guillotine import (
    Bid,
    League,
    Player,
    Team,
    best_bid,
    best_lineup,
    draws,
    prize_fractions,
    recommend,
    simulate,
    slot_labels,
    team_curve,
    weekly_means,
)

SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "BN", "BN"]


def _p(name, pos, proj, team="AAA", **kw):
    return Player(pid=name, name=name, pos=pos, team=team, proj=proj, proj_sd=4 + 0.31 * (proj or 0),
                  avg=kw.pop("avg", proj), recent=kw.pop("recent", proj), games=kw.pop("games", 8), **kw)


def _roster(tag, scale=1.0):
    base = [("QB", 18), ("RB", 15), ("RB", 12), ("RB", 8), ("WR", 16), ("WR", 13), ("WR", 10), ("WR", 7), ("TE", 9)]
    return [_p(f"{tag}{i}", pos, pts * scale) for i, (pos, pts) in enumerate(base)]


def _league(**kw):
    teams = [
        Team(1, "me", 600, _roster("m", 0.95), is_me=True),
        Team(2, "rich", 900, _roster("r", 1.0)),
        Team(3, "weak", 300, _roster("w", 0.8)),
        Team(4, "strong", 100, _roster("s", 1.2)),
    ]
    fa = [_p("stud", "WR", 22), _p("ok", "RB", 11), _p("scrub", "WR", 4)]
    return League(week=10, last_week=12, slots=SLOTS, teams=teams, free_agents=fa, **kw)


def test_best_lineup_fills_slots_then_flex():
    pos = ["QB", "QB", "RB", "RB", "RB", "WR", "WR", "WR", "TE", "TE"]
    mean = np.array([20, 19, 15, 12, 11, 14, 9, 8, 7, 10.5])
    idx = best_lineup(pos, mean, SLOTS)
    assert len(idx) == 8 and 1 not in idx                 # second QB never flexes
    assert set(idx) == {0, 2, 3, 5, 6, 9, 4, 7}           # best TE in the TE slot; RB3 and WR3 flex


def test_bye_and_injured_reserve_zero_the_week():
    lg = _league(byes={"AAA": {11}})
    p = _p("x", "WR", 15)
    assert weekly_means(lg, p).tolist()[1] == 0 and weekly_means(lg, p)[0] == 15
    ir = _p("y", "WR", None, status="IR", avg=20, recent=20)
    m = weekly_means(lg, ir)                              # weeks 10, 12 missed (11 is the bye), then back
    assert m.tolist() == [0, 0, 0]
    lg.ir_games = 1
    assert weekly_means(lg, ir).tolist() == [0, 0, 20]
    out = _p("z", "RB", 12, status="Out")
    assert weekly_means(lg, out)[0] == 0 and weekly_means(lg, out)[2] > 0


def test_simulation_chops_one_team_a_week_and_weak_teams_first():
    lg = _league()
    mu = np.vstack([team_curve(lg, t.players)[0] for t in lg.teams])
    sd = np.vstack([team_curve(lg, t.players)[1] for t in lg.teams])
    o = simulate(mu, sd, draws(8000, mu.shape[1], 4))
    assert np.allclose(o.chop_week.sum(axis=0), 1.0)      # exactly one team goes each week
    assert abs(o.win.sum() - 1.0) < 1e-9
    assert o.chop_now[2] > o.chop_now[0] > o.chop_now[3]   # weak > me > strong
    assert o.win[3] > o.win[2]


def test_prize_fractions_use_money_at_the_time_and_count_no_bid_as_zero():
    bids = [Bid(0, 2, "a", 300, True, 1000), Bid(0, 3, "a", 100, False, 1000), Bid(0, 4, "zz", 1, True, 1000),
            Bid(1, 2, "b", 350, False, 700), Bid(1, 3, "b", 400, True, 1000)]
    per, pooled = prize_fractions(_league(bids=bids), top_n=1)
    assert per[2] == [0.3, 0.5] and per[3] == [0.1, 0.4] and per[4] == [0.0]
    assert len(pooled) == 5


def test_best_bid_trades_price_against_the_chance_to_win():
    top = np.linspace(0, 400, 4001)                       # rivals' highest bid: uniform 0–400
    b, p = best_bid(top, value=80, dollar=0.1, limit=600, budgets=[400, 250])
    assert 380 <= b <= 401 and p > 0.94                   # cheap money: just beat everyone
    b2, p2 = best_bid(top, value=80, dollar=0.3, limit=600, budgets=[])
    assert 120 <= b2 <= 145 and 0.3 < p2 < 0.37           # dear money: optimum of p·(80 − 0.3b) is b ≈ 133
    assert best_bid(top, value=0, dollar=0.1, limit=600, budgets=[]) == (0, 0.0)


def test_recommend_targets_the_stud_within_budget_and_never_over_it():
    bids = [Bid(w, rid, f"p{w}", amt, False, 900) for w in range(4) for rid, amt in ((2, 250), (3, 200), (4, 60))]
    lg = _league(bids=bids)
    res = recommend(lg, n_sim=4000)
    top = res.recs[0]
    assert top.player.name == "stud" and top.d_chop < 0 and top.d_win > 0
    assert 0 < top.bid <= lg.me.budget
    assert top.bid_50 <= top.bid_80 <= top.bid_95 <= 900 + 1
    assert "strong" not in top.beats_all_but               # $100 cannot outbid a real bid
    assert all(r.bid == 0 or r.drop for r in res.recs)
    assert sum(r.bid for r in res.recs if r.group != top.group) + top.bid <= lg.me.budget
    assert res.drops[0][1] <= res.drops[-1][1]             # least valuable first


def test_start_sit_needs_and_what_is_coming():
    assert slot_labels(SLOTS) == ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX1", "FLEX2"]
    lg = _league()
    lg.teams[0].players.append(_p("hurt", "WR", 30, status="Out"))      # the best player on paper, but out
    res = recommend(lg, n_sim=2000)
    start = [d for d in res.lineup if d["start"]]
    assert len(start) == 8 and "hurt" not in {d["name"] for d in start}
    assert [d["spot"] for d in start if d["pos"] == "QB"] == ["QB"]
    assert len(res.lineup) == len(lg.me.players)
    # my roster is 5% under the reference roster: every spot trails the league median or ties it
    assert res.needs and res.needs[0]["gap"] <= res.needs[-1]["gap"]
    # the weak team is the likeliest to be chopped, and its odds grow over three weeks
    assert res.coming[0]["owner"] == "weak" and res.coming[0]["chop_3"] >= res.coming[0]["chop_1"] > 0.3
    assert all(len(c["players"]) <= 3 for c in res.coming) and {c["owner"] for c in res.coming} == {"rich", "weak", "strong"}
    assert res.advice["verdict"] in {"now", "wait", "either", "hold"} and res.advice["now"]["name"] == "stud"


def test_wait_when_better_players_are_about_to_come_free():
    lg = _league()
    lg.free_agents = [_p("meh", "WR", 11.5)]
    lg.teams[0].players = _roster("m", 1.3)                             # I am in no danger this week
    lg.teams[2].players = _roster("w", 0.6) + [_p("star", "WR", 30)]    # on the team most likely to go
    res = recommend(lg, n_sim=2000)
    assert res.advice["my_chop"] < 0.15 and res.coming[0]["owner"] == "weak"
    assert res.advice["verdict"] == "wait" and res.advice["later_gain"] > res.advice["now"]["gain"]
