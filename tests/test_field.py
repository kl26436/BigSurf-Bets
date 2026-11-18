"""The field: projected ownership, sampled opponents, payouts — and the week-10 2026
slate replayed as a regression case. No network, no database."""

from pathlib import Path

import numpy as np
import polars as pl
import pytest

pytest.importorskip("scipy")

from optimizer import ownership, portfolio, store  # noqa: E402
from optimizer.sim import simulate  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "w10_2026_pool.txt"
NEED = {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "DST": 1}


def week10() -> pl.DataFrame:
    """The slate as the builder saw it at 11:40 CT on Nov 15 2026, with real results and ownership."""
    rows = [line.strip().split("|") for line in FIXTURE.read_text().splitlines() if line.strip() and not line.startswith("#")]
    f = lambda x: float(x) if x != "-" else 0.0   # noqa: E731
    df = pl.DataFrame([dict(
        dk_id=r[0], player_id=r[0], name=r[1], pos=r[2], team=r[3], opponent=r[4], kickoff=r[5], salary=int(r[6]),
        status=None, dk_mean=f(r[8]), dk_std=f(r[9]), dk_p10=f(r[10]), dk_p25=f(r[11]), dk_p50=f(r[12]), dk_p75=f(r[13]),
        dk_p90=f(r[14]), actual=f(r[15]), own_real=f(r[16]) / 100) for r in rows], schema_overrides={"status": pl.Utf8})
    return df.with_columns(
        pl.concat_str([pl.min_horizontal("team", "opponent"), pl.max_horizontal("team", "opponent")], separator="-").alias("game")
    ).sort("salary", "dk_id", descending=[True, False])


def lifted(df: pl.DataFrame, name: str, mean: float) -> pl.DataFrame:
    r = mean / df.filter(pl.col("name") == name)["dk_mean"][0]
    cols = ("dk_mean", "dk_std", "dk_p10", "dk_p25", "dk_p50", "dk_p75", "dk_p90")
    return df.with_columns(*[pl.when(pl.col("name") == name).then(pl.col(c) * r).otherwise(pl.col(c)).alias(c) for c in cols])


@pytest.fixture(scope="module")
def slate() -> pl.DataFrame:
    return week10()


def test_ownership_adds_up_by_position_and_follows_value(slate):
    own = ownership.project(slate)
    pos = slate["pos"].to_numpy()
    for p, share in ownership.SLOT_SHARE.items():
        assert own[pos == p].sum() == pytest.approx(share, abs=0.02)
    assert own.max() <= ownership.MAX_SHARE + 1e-9 and own.min() >= 0
    # on the week it was fitted to, it tracks the real contest (in-sample: a floor, not a claim)
    assert np.corrcoef(own, slate["own_real"].to_numpy())[0, 1] > 0.55
    # a better projection at the same price means more of the field
    up = ownership.project(lifted(slate, "Emmett Johnson", 15.63))
    i = slate["name"].to_list().index("Emmett Johnson")
    assert up[i] > 2 * own[i]


def test_sampled_field_is_legal_and_matches_ownership(slate):
    own = np.maximum(slate["own_real"].to_numpy(), 1e-4)
    field = ownership.sample_field(slate, own, 3000, seed=3)
    assert field.shape == (3000, 9)
    pos, sal = slate["pos"].to_numpy(), slate["salary"].to_numpy()
    assert all(len(set(row)) == 9 for row in field[:300])
    for row in field[:300]:
        counts = {p: int((pos[row] == p).sum()) for p in NEED}
        assert counts["QB"] == 1 and counts["DST"] == 1
        assert all(counts[p] >= NEED[p] for p in NEED) and sum(counts.values()) == 9
    total = sal[field].sum(1)
    assert total.max() <= ownership.FIELD_SALARY[1] and total.min() >= ownership.FIELD_SALARY[0]
    seen = np.bincount(field.ravel(), minlength=slate.height) / len(field)
    assert np.corrcoef(seen, own)[0, 1] > 0.95
    # drawn from the true ownership, the field's real scores land near (and a little under) the contest's own
    scores = slate["actual"].to_numpy()[field].sum(1)
    assert 140 < np.quantile(scores, 0.5) < 156          # the contest's middle score was 152.3
    assert 175 < np.quantile(scores, 0.9) < 198          # its top-10% score was 193.7


def test_payouts_pay_the_best_tier_reached():
    lines = np.array([[100, 120, 140, 160, 180]], np.float32).repeat(4, 0)
    pay = ownership.payouts(np.array([99.0, 100.0, 150.0, 500.0]), lines)
    mult = [m for _, m in ownership.PAYOUT_TIERS]
    assert pay.tolist() == pytest.approx([0.0, mult[0], mult[2], mult[4]])


def test_fit_recovers_the_weights_and_needs_two_slates(slate):
    truth = ownership.Coef(1.4, 0.2)
    frames = []
    for k, bump in enumerate((0.0, 1.5, -1.0)):
        d = slate.with_columns((pl.col("dk_mean") + bump * (pl.col("salary") % 700) / 700).alias("dk_mean"))
        frames.append(d.select(pl.lit(k).alias("slate"), "pos", "salary", "dk_mean").with_columns(pl.Series("own", ownership.project(d, truth))))
    got = ownership.fit(pl.concat(frames))
    assert got.value == pytest.approx(1.4, abs=0.1) and got.proj == pytest.approx(0.2, abs=0.1) and got.n_slates == 3
    assert ownership.fit(frames[0]) == ownership.DEFAULT


def test_field_build_week10_replay(slate):
    """The week this was built for. With the starter's carries handed to Emmett Johnson
    (model/volume.py: 11.9 → 15.6 points at $4,700) he belongs in the set, and picking by
    what a lineup wins against the field keeps the set's projection up."""
    pool = lifted(slate, "Emmett Johnson", 15.63).drop("actual", "own_real")
    st = dict(n=8, mode="gpp", max_exposure=0.5, n_sims=3000)
    new = portfolio.build(pool, portfolio.Settings(**st, field_size=2000))
    old = portfolio.build(pool, portfolio.Settings(**st, vs_field=False))
    assert len(new.lineups) == 8 and new.lines is not None and old.lines is None
    names = pool["name"].to_list()
    ej = names.index("Emmett Johnson")
    assert sum(ej in set(lu.tolist()) for lu in new.lineups) >= 3
    sal, mean = pool["salary"].to_numpy(), pool["dk_mean"].to_numpy()
    counts = np.zeros(pool.height, int)
    for lu in new.lineups:
        assert len(lu) == 9 and 48_500 <= sal[lu].sum() <= 50_000
        counts[lu] += 1
    assert counts.max() <= 4                                            # the 50% cap
    assert np.mean([mean[lu].sum() for lu in new.lineups]) >= np.mean([mean[lu].sum() for lu in old.lineups]) - 0.5
    view = new.field_view()
    assert 0 < view["cash_rate"] < 1 and view["exp_return"] > 0 and view["field_slates"] == 1
    assert store.set_summary(new)["field"] == view and "field" not in store.set_summary(old)
    # deterministic: the same inputs give the same set
    again = portfolio.build(pool, portfolio.Settings(**st, field_size=2000))
    assert [lu.tolist() for lu in again.lineups] == [lu.tolist() for lu in new.lineups]


def test_field_lines_rise_with_the_tier(slate):
    pool = slate.drop("actual", "own_real")
    sims = simulate(pool, None, 1500, 5)
    field = ownership.sample_field(pool, ownership.project(pool), 1500, 5)
    lines = ownership.field_lines(sims, field)
    assert lines.shape == (1500, len(ownership.PAYOUT_TIERS)) and (np.diff(lines, axis=1) >= 0).all()
