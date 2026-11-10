"""Model tests run on a tiny synthetic league — no network, no database."""

import numpy as np
import polars as pl
import pytest

pytest.importorskip("lightgbm")

from model import dst, features, train  # noqa: E402
from model.data import NFLData  # noqa: E402
from model.dist import Empirical, NegBin, american_to_prob, no_vig  # noqa: E402
from model.project import fair_american  # noqa: E402

TEAMS = ["AAA", "BBB", "CCC", "DDD"]
ROSTER = [("QB", 1), ("RB", 2), ("WR", 3), ("TE", 1)]


def _league(seasons=(2023, 2024, 2025), weeks=10, seed=0) -> NFLData:
    """4 teams, 7 skill players each, every stat driven by a stable per-player
    talent level so there is real signal to learn."""
    rng = np.random.default_rng(seed)
    players, talent = [], {}
    for t in TEAMS:
        for pos, n in ROSTER:
            for i in range(n):
                pid = f"{t}-{pos}{i}"
                players.append(dict(
                    gsis_id=pid, display_name=pid, position_group=pos, position=pos, birth_date="1998-01-01",
                    rookie_season=2020, draft_pick=float(rng.integers(1, 200)), height=74.0, weight=215.0,
                    latest_team=t, status="ACT", pfr_id=f"pfr-{pid}",
                ))
                talent[pid] = rng.uniform(0.5, 1.5) / (i + 1)
    stats, sched, snaps = [], [], []
    for s in seasons:
        for w in range(1, weeks + 1):
            order = list(rng.permutation(TEAMS))
            for home, away in ((order[0], order[1]), (order[2], order[3])):
                gid = f"{s}_{w:02d}_{away}_{home}"
                sched.append(dict(
                    game_id=gid, season=s, week=w, game_type="REG", gameday=f"{s}-{9 + (w - 1) // 4:02d}-{1 + 7 * ((w - 1) % 4):02d}",
                    home_team=home, away_team=away, home_score=int(rng.integers(10, 35)), away_score=int(rng.integers(10, 35)),
                    spread_line=float(rng.integers(-7, 8)), total_line=44.5, roof="outdoors",
                    home_qb_id=f"{home}-QB0", away_qb_id=f"{away}-QB0",
                ))
                for team, opp in ((home, away), (away, home)):
                    for p in players:
                        if p["latest_team"] != team:
                            continue
                        pid, pos, k = p["gsis_id"], p["position_group"], talent[p["gsis_id"]]
                        att = int(rng.poisson(33 * k)) if pos == "QB" else 0
                        car = int(rng.poisson({"QB": 3, "RB": 14, "WR": 0.3, "TE": 0.1}[pos] * k))
                        tgt = int(rng.poisson({"QB": 0, "RB": 3, "WR": 8, "TE": 5}[pos] * k))
                        rec = int(rng.binomial(tgt, 0.65))
                        row = dict(
                            player_id=pid, season=s, week=w, team=team, opponent_team=opp, position_group=pos,
                            completions=int(att * 0.64), attempts=att, passing_yards=att * 7, passing_tds=int(rng.poisson(att / 22)),
                            passing_interceptions=int(rng.poisson(att / 45)), sacks_suffered=int(att / 15),
                            passing_air_yards=att * 8, passing_epa=att * 0.05, passing_2pt_conversions=0,
                            carries=car, rushing_yards=int(car * 4.3), rushing_tds=int(rng.poisson(car / 30)),
                            rushing_epa=0.0, rushing_2pt_conversions=0,
                            targets=tgt, receptions=rec, receiving_yards=int(rec * 11.5), receiving_tds=int(rng.poisson(tgt / 20)),
                            receiving_air_yards=tgt * 9, receiving_epa=0.0, receiving_2pt_conversions=0,
                            sack_fumbles_lost=0, rushing_fumbles_lost=0, receiving_fumbles_lost=0,
                            special_teams_tds=0, fumble_recovery_tds=0, fantasy_points_ppr=0.0,
                        )
                        row["fantasy_points_ppr"] = (
                            0.04 * row["passing_yards"] + 4 * row["passing_tds"] + 0.1 * row["rushing_yards"]
                            + 6 * row["rushing_tds"] + rec + 0.1 * row["receiving_yards"] + 6 * row["receiving_tds"]
                        )
                        stats.append(row)
                        snaps.append(dict(
                            season=s, week=w, pfr_player_id=p["pfr_id"], team=team, opponent=opp,
                            offense_snaps=60.0 * min(1.0, k), offense_pct=min(1.0, k),
                        ))
    inj = pl.DataFrame(
        {"season": [2023], "week": [1], "gsis_id": ["AAA-WR2"], "team": ["AAA"], "report_status": ["Questionable"],
         "practice_status": ["Limited Participation in Practice"]},
        schema_overrides={"season": pl.Int32, "week": pl.Int32},
    )
    i32 = {"season": pl.Int32, "week": pl.Int32}
    # team-level defensive box score; defense strength is a stable per-team trait
    toughness = {t: 0.6 + 0.3 * i for i, t in enumerate(TEAMS)}
    team = []
    for g in sched:
        for t, o in ((g["home_team"], g["away_team"]), (g["away_team"], g["home_team"])):
            k = toughness[t]
            team.append(dict(
                season=g["season"], week=g["week"], team=t, opponent_team=o,
                def_sacks=float(rng.poisson(2.4 * k)), def_interceptions=int(rng.poisson(0.8 * k)),
                fumble_recovery_opp=int(rng.poisson(0.5 * k)), def_tds=int(rng.poisson(0.08)), special_teams_tds=0,
                def_safeties=0, def_punt_blocks=0, def_fg_blocks=0, def_pat_blocks=0,
                def_qb_hits=int(rng.poisson(5 * k)), def_tackles_for_loss=int(rng.poisson(4 * k)),
                def_pass_defended=int(rng.poisson(4 * k)), sacks_suffered=int(rng.poisson(2.4)),
                passing_interceptions=int(rng.poisson(0.8)), sack_fumbles_lost=0, rushing_fumbles_lost=0,
                receiving_fumbles_lost=0, attempts=int(rng.poisson(33)),
            ))
    return NFLData(
        stats=pl.DataFrame(stats, schema_overrides=i32), schedules=pl.DataFrame(sched, schema_overrides=i32),
        injuries=inj, snaps=pl.DataFrame(snaps, schema_overrides=i32), players=pl.DataFrame(players),
        team_stats=pl.DataFrame(team, schema_overrides=i32),
    )


@pytest.fixture(scope="module")
def league() -> NFLData:
    return _league()


def test_features_do_not_see_the_game_they_describe(league):
    """Leak guard: rewrite one game's box score; that row's features must not
    move, and the same player's *next* game must."""
    base = features.build(league)
    row = base.filter((pl.col("player_id") == "AAA-WR0") & (pl.col("season") == 2024) & (pl.col("week") == 5))
    assert row.height == 1
    hit = (pl.col("player_id") == "AAA-WR0") & (pl.col("season") == 2024) & (pl.col("week") == 5)
    doctored = NFLData(
        stats=league.stats.with_columns(
            pl.when(hit).then(40).otherwise(pl.col("targets")).alias("targets"),
            pl.when(hit).then(400).otherwise(pl.col("receiving_yards")).alias("receiving_yards"),
        ),
        schedules=league.schedules, injuries=league.injuries, snaps=league.snaps, players=league.players,
    )
    alt = features.build(doctored)
    feats = features.feature_columns(base)
    a = base.filter(hit).select(feats).to_numpy().astype(float)
    b = alt.filter(hit).select(feats).to_numpy().astype(float)
    # tolerance, not equality: group-by summation order is not deterministic to the last bit
    np.testing.assert_allclose(a, b, rtol=1e-9, atol=1e-9, equal_nan=True)
    nxt = (pl.col("player_id") == "AAA-WR0") & (pl.col("season") == 2024) & (pl.col("week") == 6)
    assert base.filter(nxt)["targets_s"][0] != alt.filter(nxt)["targets_s"][0]


def test_upcoming_rows_match_history_features_and_respect_outs(league):
    """Projecting week N from data through N-1 must give exactly the features
    the historical frame has for week N; ruled-out players drop out and their
    usage shows up as vacated for teammates."""
    hist = features.build(league)
    up = features.build(league, upcoming=(2025, 10))
    fut = up.filter(pl.col("is_future"))
    assert fut.height == 28 and fut["week"].unique().to_list() == [10]
    assert fut.select(pl.col("targets").is_null().all()).item()
    h = hist.filter((pl.col("season") == 2025) & (pl.col("week") == 10)).sort("player_id")
    f = fut.sort("player_id")
    assert h["player_id"].to_list() == f["player_id"].to_list()
    for c in ("targets_l", "dk_s", "off_attempts_l", "def_dk_pos", "defadj_dk_pos", "implied_total", "qb_yds_per_att", "exp_targets"):
        np.testing.assert_allclose(h[c].to_numpy(), f[c].to_numpy(), rtol=1e-9, equal_nan=True, err_msg=c)

    out = features.build(league, upcoming=(2025, 10), out_ids={"AAA-WR0"}).filter(pl.col("is_future"))
    assert "AAA-WR0" not in out["player_id"].to_list()
    wr1 = out.filter(pl.col("player_id") == "AAA-WR1")
    assert wr1["miss_target_share"][0] > 0.05
    assert wr1["exp_targets"][0] > f.filter(pl.col("player_id") == "AAA-WR1")["exp_targets"][0]


def test_fit_predict_beats_nothing_and_is_coherent(league):
    df = features.build(league, upcoming=(2025, 10))
    model, oof = train.fit(df, [2023, 2024, 2025], params=dict(n_estimators=60, min_child_samples=10))
    assert oof.height == model.n_rows
    pred = train.predict(model, df.filter(pl.col("is_future")))
    # non-QBs get no passing projection, QBs no receiving projection
    assert pred.filter(pl.col("pos") != "QB")["proj_passing_yards"].abs().max() == 0
    assert pred.filter(pl.col("pos") == "QB")["proj_targets"].abs().max() == 0
    # quantiles are ordered and the mean is inside the 10–90 band
    for k in ("dk", "ppr"):
        q = pred.select([f"proj_{k}_p{p}" for p in (10, 25, 50, 75, 90)]).to_numpy()
        assert (np.diff(q, axis=1) >= -1e-9).all()
    # talent is learnable: WR1s project above WR3s
    by = dict(zip(pred["player_id"], pred["proj_targets"], strict=True))
    assert np.mean([by[f"{t}-WR0"] for t in TEAMS]) > np.mean([by[f"{t}-WR2"] for t in TEAMS])
    # probabilities fall as the line rises
    p = train.prob_over(model, "receiving_yards", np.full(3, 60.0), np.array([30.5, 60.5, 90.5]))
    assert p[0] > p[1] > p[2]


def test_negbin_matches_simulation():
    rng = np.random.default_rng(1)
    mu = rng.uniform(2, 9, 20000)
    n = 1 / 0.2
    y = rng.negative_binomial(n, n / (n + mu))
    d = NegBin.fit(mu, y)
    assert abs(d.alpha - 0.2) < 0.03
    assert abs(d.prob_over(np.array([5.0]), np.array([5.5]))[0] - (rng.negative_binomial(n, n / (n + 5.0), 200000) > 5.5).mean()) < 0.01


def test_empirical_is_calibrated_on_skewed_data():
    rng = np.random.default_rng(2)
    mu = rng.uniform(10, 90, 30000)
    y = rng.gamma(2.0, mu / 2.0)  # mean mu, right-skewed
    d = Empirical.fit(mu[:20000], y[:20000])
    p = d.prob_over(mu[20000:], mu[20000:])  # P(above own mean) < 0.5 for a right-skewed outcome
    hit = y[20000:] > mu[20000:]
    assert abs(p.mean() - hit.mean()) < 0.02 and p.mean() < 0.47
    assert abs(d.mean(np.array([50.0]))[0] - 50) < 3


def test_odds_helpers():
    assert american_to_prob(-110) == pytest.approx(0.5238, abs=1e-4)
    assert american_to_prob(150) == pytest.approx(0.4)
    assert no_vig(0.5238, 0.5238) == pytest.approx((0.5, 0.5))
    assert fair_american(0.6) == -150 and fair_american(0.4) == 150


def test_dst_scoring_and_no_leak(league):
    hist = dst.build(league)
    # DK scoring identity on a played game
    r = hist.filter(pl.col("sacks").is_not_null()).row(5, named=True)
    tier = pl.DataFrame({"p": [r["points_allowed"]]}).select(dst.pa_tier(pl.col("p"))).item()
    assert r["dk"] == pytest.approx(
        r["sacks"] + 2 * r["interceptions"] + 2 * r["fumble_recoveries"] + 6 * r["tds"] + 2 * r["safeties"] + 2 * r["blocks"] + tier
    )
    tiers = pl.DataFrame({"p": [0, 6, 7, 13, 14, 20, 21, 27, 28, 34, 35]}).select(dst.pa_tier(pl.col("p")))[:, 0].to_list()
    assert tiers == [10, 7, 4, 4, 1, 1, 0, 0, -1, -1, -4]
    # upcoming rows carry exactly the features history has for that week, and no outcomes
    up = dst.build(league, upcoming=(2025, 10)).filter(pl.col("is_future")).sort("team")
    h = hist.filter((pl.col("season") == 2025) & (pl.col("week") == 10)).sort("team")
    assert up.height == 4 and up["dk"].null_count() == 4
    np.testing.assert_allclose(
        h.select(dst.FEATURES).to_numpy().astype(float), up.select(dst.FEATURES).to_numpy().astype(float),
        rtol=1e-9, atol=1e-9, equal_nan=True,
    )


def test_dst_fit_predict(league):
    df = dst.build(league, upcoming=(2025, 10))
    model = dst.fit(df, [2023, 2024, 2025], params=dict(n_estimators=40, min_child_samples=5))
    pred = dst.predict(model, df.filter(pl.col("is_future")))
    assert pred.height == 4 and pred["proj_dk"].is_finite().all()
    q = pred.select([f"proj_dk_p{p}" for p in (10, 25, 50, 75, 90)]).to_numpy()
    assert (np.diff(q, axis=1) >= -1e-9).all()
    by = dict(zip(pred["team"], pred["proj_sacks"], strict=True))
    assert by["DDD"] > by["AAA"]  # the tougher defense projects more sacks
