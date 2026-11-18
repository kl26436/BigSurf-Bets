"""Who the rest of the contest will play, and what it takes to beat them.

A tournament pays for finishing ahead of other people's lineups, not for
points. Two lineups with the same projection are not worth the same: the one
built from the players everybody has needs those players to fail in other
lineups to move up, and the one that skips a player half the field has is
buried the week he hits. This module gives the builder that view:

  project()        each player's expected share of the field's lineups
  sample_field()   a few thousand lineups drawn the way the field builds them
  payouts()        what a score is worth in each simulated Sunday, measured
                   against where the sampled field's scores fall

How ownership is estimated: within a position, a player's share grows with his
value (projected points per $1,000) and his projection. The two weights were
fitted to the one contest on file with ownership (DraftKings $500K Play-Action,
week 10 2026, 198,176 entries): predicted and actual shares correlate 0.64–0.81
by position on that same week. That is an in-sample figure from a single slate;
`fit()` refits from every contest results file added in the app, and the
weights should be trusted more as those accumulate. The model sees only our
projections, so it misses a player the field likes for a reason we do not have."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

# share of field lineups a position's players add up to (FLEX included): week 10 2026, $500K contest
SLOT_SHARE = {"QB": 1.0, "RB": 2.44, "WR": 3.29, "TE": 1.22, "DST": 1.0}
FLEX_POS = ("RB", "WR", "TE")
NEED = {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "DST": 1}
MAX_SHARE = 0.85
STACK_BOOST = 2.5            # how much likelier the field is to pair its QB with his own WR/TE
FIELD_SALARY = (48_500, 50_000)
# Real fields score higher than lineups drawn player by player: people stack games and
# run optimizers. Drawn from the true week-10 ownership, the sampled field's real scores
# sat 3–4% under the contest's at every percentile (148 vs 152 at the middle, 186 vs 194
# at the top 10%). One contest's worth of evidence; revisit as results files are added.
FIELD_EDGE = 1.03
# What finishing in the top x of a large tournament pays, in entry fees. Shaped like a
# DraftKings large-field contest ($3 entry, ~200,000 entries): the bottom of the paid
# places gets its fee back and a bit, and the money climbs slowly until the last few
# hundred places. The top 0.1% is as far as a sampled field can see: first place and the
# final table (about a tenth of the prize pool) are not valued here at all, so this
# under-rates a long shot's ceiling and should be read as "how often, and how well, does
# this lineup get paid", not as the contest's true expected value.
PAYOUT_TIERS = ((0.22, 1.67), (0.10, 2.0), (0.025, 3.3), (0.005, 6.7), (0.001, 25.0))


@dataclass(frozen=True)
class Coef:
    value: float = 0.75      # weight on points per $1,000, in standard deviations within the position
    proj: float = 0.5        # weight on projected points, same units
    n_slates: int = 1        # slates of real ownership behind the weights


DEFAULT = Coef()


def _z(x: np.ndarray) -> np.ndarray:
    sd = x.std()
    return (x - x.mean()) / sd if sd > 1e-9 else np.zeros_like(x)


def project(pool: pl.DataFrame, coef: Coef = DEFAULT) -> np.ndarray:
    """Expected share of the field's lineups holding each player (0–1), in pool order."""
    pos = pool["pos"].to_numpy()
    mean = pool["dk_mean"].to_numpy().astype(float)
    sal = np.maximum(pool["salary"].to_numpy().astype(float), 1.0)
    own = np.zeros(pool.height)
    for p, slots in SLOT_SHARE.items():
        idx = np.flatnonzero(pos == p)
        if idx.size == 0:
            continue
        u = coef.value * _z(mean[idx] / sal[idx] * 1000) + coef.proj * _z(mean[idx])
        w = np.exp(u - u.max())
        share = slots * w / w.sum()
        for _ in range(20):                      # nobody above MAX_SHARE: hand the excess to the rest
            over = share > MAX_SHARE
            if not over.any() or over.all():
                break
            excess = (share[over] - MAX_SHARE).sum()
            share[over] = MAX_SHARE
            share[~over] += excess * share[~over] / share[~over].sum()
        own[idx] = np.minimum(share, MAX_SHARE)
    return own


def fit(rows: pl.DataFrame, min_slates: int = 2) -> Coef:
    """Refit the two weights from real ownership. `rows`: slate, pos, salary, dk_mean,
    own (share 0–1 of lineups). Falls back to DEFAULT below `min_slates` slates."""
    from scipy.optimize import minimize

    rows = rows.filter(pl.col("dk_mean").is_not_null() & (pl.col("dk_mean") >= 3) & pl.col("pos").is_in(list(SLOT_SHARE)))
    n_slates = rows["slate"].n_unique() if rows.height else 0
    if n_slates < min_slates:
        return DEFAULT
    groups = []
    for (_, _), g in rows.group_by("slate", "pos"):
        own = g["own"].to_numpy().astype(float)
        if own.sum() <= 0 or g.height < 4:
            continue
        mean, sal = g["dk_mean"].to_numpy().astype(float), g["salary"].to_numpy().astype(float)
        groups.append((_z(mean / sal * 1000), _z(mean), own / own.sum(), own.sum()))

    def loss(theta):
        total = 0.0
        for zv, zp, share, weight in groups:
            u = theta[0] * zv + theta[1] * zp
            logp = u - (u.max() + np.log(np.exp(u - u.max()).sum()))
            total -= weight * float((share * logp).sum())
        return total

    res = minimize(loss, [DEFAULT.value, DEFAULT.proj], method="Nelder-Mead", options={"xatol": 1e-3, "fatol": 1e-5})
    a, b = (float(np.clip(v, 0.0, 4.0)) for v in res.x)
    return Coef(round(a, 3), round(b, 3), n_slates)


def fit_from_db(conn) -> Coef:
    """Weights from every contest results file on record (the largest contest of each slate)."""
    try:
        with conn.transaction():      # a savepoint: a failure here must not undo the caller's work
            cur = conn.execute(
                """with big as (select distinct on (c.slate_id) c.id, c.slate_id from bsb.contests c
                                where c.slate_id is not null order by c.slate_id, c.n_entries desc),
                        o as (select b.slate_id, co.player_name, sum(co.pct_drafted) / 100.0 as own
                              from big b join bsb.contest_ownership co on co.contest_id = b.id group by 1, 2)
                   select s.slate_id, s.position, s.salary, r.proj_dk::float8, coalesce(o.own, 0)::float8
                   from bsb.dfs_salaries s
                   join bsb.dfs_slates sl on sl.id = s.slate_id and sl.slate_type = 'classic'
                   join bsb.player_results r on r.player_id = s.player_id and r.season = sl.season and r.week = sl.week
                   left join o on o.slate_id = s.slate_id and o.player_name = s.player_name
                   where s.slate_id in (select slate_id from big)"""
            )
            fetched = cur.fetchall()
        rows = pl.DataFrame(fetched, schema=["slate", "pos", "salary", "dk_mean", "own"], orient="row", infer_schema_length=None)
        return fit(rows)
    except Exception:  # noqa: BLE001  a missing table or an empty history must never stop a lineup build
        return DEFAULT


def sample_field(pool: pl.DataFrame, own: np.ndarray, n: int = 2500, seed: int = 11) -> np.ndarray:
    """→ (n, 9) player indices: lineups drawn the way the field builds them — by
    ownership within each position, the QB usually with one of his own pass
    catchers, most of the salary spent. Fewer than `n` rows when the pool is
    too thin to fill a lineup."""
    rng = np.random.default_rng(seed)
    pos, team = pool["pos"].to_numpy(), pool["team"].to_numpy()
    sal = pool["salary"].to_numpy().astype(float)
    by = {p: np.flatnonzero((pos == p) & (own > 0)) for p in NEED}
    if any(by[p].size < NEED[p] for p in NEED) or sum(by[p].size for p in FLEX_POS) < 7:
        return np.empty((0, 9), int)
    logw = {p: np.log(own[by[p]]) for p in NEED}
    flex_idx = np.concatenate([by[p] for p in FLEX_POS])
    flex_logw = np.log(own[flex_idx])
    out: list[np.ndarray] = []
    got = 0
    for _ in range(40):
        m = max(2 * (n - got), 500)
        def g(k: int, m: int = m) -> np.ndarray:   # Gumbel top-k = sampling without replacement by weight
            return rng.gumbel(size=(m, k))

        qb = by["QB"][np.argmax(logw["QB"][None, :] + g(by["QB"].size), axis=1)]
        dst = by["DST"][np.argmax(logw["DST"][None, :] + g(by["DST"].size), axis=1)]
        picks = {}
        for p in FLEX_POS:
            key = logw[p][None, :] + g(by[p].size)
            if p in ("WR", "TE"):
                key = key + np.log(STACK_BOOST) * (team[by[p]][None, :] == team[qb][:, None])
            order = np.argsort(-key, axis=1)
            picks[p] = (by[p][order[:, : NEED[p]]], key)
        core = np.column_stack([qb, picks["RB"][0], picks["WR"][0], picks["TE"][0]])
        # the FLEX: best remaining RB/WR/TE by the same keys
        fkey = flex_logw[None, :] + g(flex_idx.size)
        taken = (flex_idx[None, None, :] == core[:, 1:, None]).any(axis=1)
        fkey[taken] = -np.inf
        flex = flex_idx[np.argmax(fkey, axis=1)]
        lineups = np.column_stack([core, flex, dst])
        total = sal[lineups].sum(axis=1)
        # the field does not roster offense against its own defense much, but does sometimes: not enforced
        ok = (total <= FIELD_SALARY[1]) & (total >= FIELD_SALARY[0])
        out.append(lineups[ok])
        got += int(ok.sum())
        if got >= n:
            break
    field = np.concatenate(out)[:n] if out else np.empty((0, 9), int)
    return field


def field_lines(sims: np.ndarray, field: np.ndarray, tiers=PAYOUT_TIERS) -> np.ndarray:
    """→ (n_sims, n_tiers): the score it takes to reach each payout tier in each simulated Sunday."""
    totals = np.zeros((sims.shape[0], field.shape[0]), np.float32)
    for j in range(field.shape[1]):
        totals += sims[:, field[:, j]].astype(np.float32)
    qs = [1 - share for share, _ in tiers]
    return (np.quantile(totals, qs, axis=1).T * FIELD_EDGE).astype(np.float32)


def payouts(lineup_totals: np.ndarray, lines: np.ndarray, tiers=PAYOUT_TIERS) -> np.ndarray:
    """What a lineup wins in each simulated Sunday, in entry fees: the pay of the best tier its score reaches."""
    pay = np.zeros(lineup_totals.shape[0], np.float32)
    for k, (_, mult) in enumerate(tiers):
        pay = np.where(lineup_totals >= lines[:, k], mult, pay)
    return pay
