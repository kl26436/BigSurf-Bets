"""DraftKings showdown (single-game, captain) lineups.

Site rules: six players from one game, $50,000. One is the captain: he costs
1.5x his salary and scores 1.5x his points. The other five are ordinary
("FLEX"). Any position, kickers and defenses included, and at least one
player from each team.

A showdown salary export lists every player twice — a captain row (its own id,
1.5x salary) and an ordinary row. `players()` folds the two into one row per
player; the solver then chooses, for each player, captain, ordinary or neither.

The same machinery as classic does the rest: an exact mixed-integer solve per
lineup, the correlated slate simulation, and a set built so that each lineup
wins on Sundays the others don't. Captain choice is what separates showdown
lineups, so two lineups with the same six players and a different captain
count as different by one."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import polars as pl
from scipy.optimize import Bounds, LinearConstraint, milp

from .portfolio import Portfolio, Settings
from .sim import simulate

SLOTS = ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"]
SALARY_CAP = 50_000
CPT = 1.5
CPT_SUFFIX = "-CPT"      # ingest/draftkings.py tags the captain row's id with this


def players(pool: pl.DataFrame) -> pl.DataFrame:
    """One row per player from a showdown pool (two rows each): `dk_id` and
    `salary` are the ordinary ones, `cpt_id` and `cpt_salary` the captain's."""
    cpt = pool.filter(pl.col("dk_id").str.ends_with(CPT_SUFFIX)).select(
        "player_id", pl.col("dk_id").alias("cpt_id"), pl.col("salary").alias("cpt_salary"))
    flex = pool.filter(~pl.col("dk_id").str.ends_with(CPT_SUFFIX))
    out = flex.join(cpt.unique("player_id"), on="player_id", how="left").with_columns(
        # an export without captain rows (or a player missing his): DraftKings' own rule
        pl.col("cpt_id").fill_null(pl.col("dk_id") + CPT_SUFFIX),
        pl.col("cpt_salary").fill_null((pl.col("salary") * CPT / 100).round() * 100).cast(pl.Int64),
    )
    return out.sort("salary", "dk_id", descending=[True, False])


@dataclass
class Rules:
    salary_cap: int = SALARY_CAP
    min_salary: int = 0
    lock: set[str] = field(default_factory=set)       # dk ids (either row of a player): must be in, in any role
    exclude: set[str] = field(default_factory=set)
    captain: set[str] = field(default_factory=set)    # dk ids: only these may be captain (empty = anyone)


class Solver:
    """Variables: [captain_0 … captain_n-1, ordinary_0 … ordinary_n-1]."""

    def __init__(self, pool: pl.DataFrame, rules: Rules | None = None):
        self.pool, self.rules = pool, rules or Rules()
        r, n = self.rules, pool.height
        self.n = n
        team = pool["team"].to_numpy()
        ids, cids = pool["dk_id"].to_numpy(), pool["cpt_id"].to_numpy()
        z, one, eye = np.zeros(n), np.ones(n), np.eye(n)
        A, lo, hi = [], [], []

        def add(row, lb, ub):
            A.append(row)
            lo.append(lb)
            hi.append(ub)

        add(np.concatenate([pool["cpt_salary"].to_numpy().astype(float), pool["salary"].to_numpy().astype(float)]), r.min_salary, r.salary_cap)
        add(np.concatenate([one, z]), 1, 1)
        add(np.concatenate([z, one]), 5, 5)
        for i in range(n):                             # a player is captain or ordinary, never both
            add(np.concatenate([eye[i], eye[i]]), 0, 1)
        teams = np.unique(team)
        if len(teams) > 1:
            for t in teams:                            # at least one player from each team
                on = (team == t).astype(float)
                add(np.concatenate([on, on]), 1, 5)
        self._A, self._lo, self._hi = np.array(A), np.array(lo, float), np.array(hi, float)
        locked = np.isin(ids, list(r.lock)) | np.isin(cids, list(r.lock))
        out = np.isin(ids, list(r.exclude)) | np.isin(cids, list(r.exclude))
        self.locked = locked & ~out
        self._lock_rows = [np.concatenate([eye[i], eye[i]]) for i in np.flatnonzero(self.locked)]
        ub = np.concatenate([1.0 - out, 1.0 - out])
        # players named as the only possible captains are, like locked players, exempt from the exposure cap:
        # the person asked for them, and with one name the cap would otherwise end the set early
        self.exempt = self.locked.copy()
        if r.captain:
            may = (np.isin(ids, list(r.captain)) | np.isin(cids, list(r.captain))) & ~out
            ub[:n] = np.minimum(ub[:n], may.astype(float))
            self.exempt |= may
        self._ub = ub

    def solve(self, scores: np.ndarray, banned: np.ndarray | None = None,
              previous: list[np.ndarray] | None = None, min_unique: int = 1) -> np.ndarray | None:
        """Best legal lineup for `scores` (per player) → [captain, five ordinary
        players sorted] as player indices, or None when nothing is legal."""
        n = self.n
        A, lo, hi = [self._A], [self._lo], [self._hi]
        if self._lock_rows:
            A.append(np.array(self._lock_rows))
            lo.append(np.ones(len(self._lock_rows)))
            hi.append(np.ones(len(self._lock_rows)))
        if previous:
            rows = np.zeros((len(previous), 2 * n))
            for k, idx in enumerate(previous):
                rows[k, idx[0]] = 1
                rows[k, n + idx[1:]] = 1
            A.append(rows)
            lo.append(np.zeros(len(previous)))
            hi.append(np.full(len(previous), 6 - min_unique))
        ub = self._ub.copy()
        if banned is not None:
            off = banned & ~self.exempt
            ub[:n][off] = 0
            ub[n:][off] = 0
        s = np.asarray(scores, float)
        res = milp(
            c=-np.concatenate([CPT * s, s]), constraints=LinearConstraint(np.vstack(A), np.concatenate(lo), np.concatenate(hi)),
            integrality=np.ones(2 * n), bounds=Bounds(np.zeros(2 * n), ub), options={"mip_rel_gap": 1e-6, "time_limit": 20},
        )
        if res.x is None:
            return None
        x = res.x > 0.5
        return np.concatenate([np.flatnonzero(x[:n]), np.flatnonzero(x[n:])])


def lineup_totals(sims: np.ndarray, idx: np.ndarray) -> np.ndarray:
    return CPT * sims[:, idx[0]] + sims[:, idx[1:]].sum(1)


@dataclass
class ShowdownPortfolio(Portfolio):
    """`lineups[k][0]` is the captain; the pool is one row per player."""

    def summary(self) -> pl.DataFrame:
        p = self.pool
        sal, csal, mean = p["salary"].to_numpy(), p["cpt_salary"].to_numpy(), p["dk_mean"].to_numpy()
        t = self.totals
        best = t.max(axis=1, keepdims=True)
        return pl.DataFrame({
            "lineup": np.arange(1, len(self.lineups) + 1),
            "salary": [int(csal[i[0]] + sal[i[1:]].sum()) for i in self.lineups],
            "proj": [round(float(CPT * mean[i[0]] + mean[i[1:]].sum()), 2) for i in self.lineups],
            "sim_mean": t.mean(0).round(2), "sim_std": t.std(0).round(2),
            "p10": np.quantile(t, 0.1, axis=0).round(1), "p50": np.quantile(t, 0.5, axis=0).round(1),
            "p90": np.quantile(t, 0.9, axis=0).round(1), "p99": np.quantile(t, 0.99, axis=0).round(1),
            "best_of_set_pct": ((t == best).mean(0) * 100).round(1),
        })

    def rows(self) -> pl.DataFrame:
        p = self.pool
        kick = p["kickoff"].to_list()
        out = []
        for k, idx in enumerate(self.lineups, 1):
            rest = sorted((int(i) for i in idx[1:]), key=lambda i: (-float(p["salary"][i]), kick[i] is None))
            for slot_no, i in enumerate([int(idx[0]), *rest]):
                cap = slot_no == 0
                out.append(dict(
                    lineup=k, slot_no=slot_no, slot="CPT" if cap else "FLEX", dk_id=p["cpt_id"][i] if cap else p["dk_id"][i],
                    player_id=p["player_id"][i], name=p["name"][i], pos=p["pos"][i], team=p["team"][i], opponent=p["opponent"][i],
                    salary=int(p["cpt_salary"][i] if cap else p["salary"][i]),
                    dk_mean=round(float(p["dk_mean"][i]) * (CPT if cap else 1.0), 2), status=p["status"][i],
                ))
        # types from the pool, not inferred: a nullable column (status) can be empty for the
        # first 100 rows and then hold "Q", which breaks polars' schema inference
        cols = ("dk_id", "player_id", "name", "pos", "team", "opponent", "status")
        return pl.DataFrame(out, schema_overrides={c: p.schema[c] for c in cols if c in p.schema},
                            infer_schema_length=None)

    def exposure(self) -> pl.DataFrame:
        """Per player, whichever role: lineups he is in, and how many of those as captain."""
        r = self.rows()
        return (
            r.group_by("player_id", "name", "pos", "team")
            .agg(pl.len().alias("lineups"), (pl.col("slot") == "CPT").sum().alias("captain"), pl.col("dk_mean").min(),
                 pl.col("salary").min())
            .with_columns((pl.col("lineups") / len(self.lineups) * 100).round(0).alias("exposure_pct"))
            .sort("lineups", "dk_mean", descending=True)
        )

    def to_dk_csv(self) -> str:
        """DraftKings bulk upload: the captain row's own id first, then the five others."""
        r = self.rows().sort("lineup", "slot_no")
        lines = [",".join(SLOTS)]
        for _, g in r.group_by("lineup", maintain_order=True):
            lines.append(",".join(i.removesuffix(CPT_SUFFIX) for i in g["dk_id"].to_list()))
        return "\n".join(lines) + "\n"


def build(pool: pl.DataFrame, settings: Settings | None = None, rules: Rules | None = None, corr: dict | None = None) -> ShowdownPortfolio:
    """`pool`: the slate's rows as `optimizer.slate` returns them (two per player)."""
    s = settings or Settings()
    p = players(pool)
    rng = np.random.default_rng(s.seed)
    sims = simulate(p, corr, s.n_sims, s.seed)
    mean = p["dk_mean"].to_numpy().astype(float)
    solver = Solver(p, rules)
    cap = max(1, math.floor(s.max_exposure * s.n + 1e-9))
    lam = 0.3 if s.mode == "gpp" else 0.12
    floor = -np.inf
    chosen: list[np.ndarray] = []
    counts = np.zeros(p.height, int)
    best_so_far = np.full(s.n_sims, -np.inf)
    notes: list[str] = []
    if p.height < 6 or p["team"].n_unique() < 2:
        notes.append("fewer than six projected players, or only one team, on this slate")

    for k in range(s.n):
        banned = counts >= cap
        cands: dict[tuple, np.ndarray] = {}
        for c in range(s.candidates):
            scores = mean if c == 0 else (1 - lam) * mean + lam * sims[rng.integers(s.n_sims)]
            idx = solver.solve(scores, banned, chosen, s.min_unique)
            if idx is not None and len(idx) == 6:
                cands[tuple(idx)] = idx
        if not cands:
            notes.append(f"stopped at {k} lineups: no legal lineup left under the exposure/uniqueness limits")
            break
        totals = {key: lineup_totals(sims, idx) for key, idx in cands.items()}
        if not chosen:
            floor = max(t.mean() for t in totals.values()) * (1 - s.max_mean_drop)
        if s.mode == "gpp":
            ok = {key: t for key, t in totals.items() if t.mean() >= floor}
            totals = ok or {max(totals, key=lambda key: totals[key].mean()): max(totals.values(), key=lambda t: t.mean())}
        if s.mode == "cash" or not chosen:
            pick = max(totals, key=lambda key: totals[key].mean())
        else:
            pick = max(totals, key=lambda key: np.maximum(best_so_far, totals[key]).mean())
        chosen.append(cands[pick])
        counts[cands[pick]] += 1
        best_so_far = np.maximum(best_so_far, totals[pick])

    t = np.column_stack([lineup_totals(sims, idx) for idx in chosen]) if chosen else np.empty((s.n_sims, 0))
    return ShowdownPortfolio(p, s, chosen, t, notes)
