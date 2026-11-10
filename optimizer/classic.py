"""DraftKings classic lineup solver.

Exact optimisation (mixed-integer program, HiGHS via scipy) rather than a
heuristic: given a score per player it returns the best legal lineup, every
time, in a few milliseconds.

Legal = 9 players, $50,000 cap, QB / 2 RB / 3 WR / TE / FLEX (RB|WR|TE) / DST,
players from at least two games. On top of the site rules sit strategy rules,
all optional: stack the QB with his pass catchers, bring back an opponent,
never roster offense against your own defense, cap players per team."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import polars as pl
from scipy.optimize import Bounds, LinearConstraint, milp

SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]
SALARY_CAP = 50_000


@dataclass
class Rules:
    salary_cap: int = SALARY_CAP
    min_salary: int = 0              # e.g. 49_000 to forbid leaving money on the table
    qb_stack: int = 0                # min WR/TE from the QB's own team
    bring_back: int = 0              # min RB/WR/TE from the QB's opponent
    max_per_team: int = 5            # offensive players from one team
    no_offense_vs_dst: bool = True   # no QB/RB/WR/TE facing your own defense
    lock: set[str] = field(default_factory=set)     # dk_ids that must be in
    exclude: set[str] = field(default_factory=set)  # dk_ids that must be out


class Solver:
    """Builds the constraint matrix for a pool once; each solve() only swaps the
    objective, bans and overlap rows — so generating hundreds of lineups is cheap."""

    def __init__(self, pool: pl.DataFrame, rules: Rules | None = None):
        self.pool, self.rules = pool, rules or Rules()
        r, n = self.rules, pool.height
        self.n = n
        pos, team, opp, game = (pool[c].to_numpy() for c in ("pos", "team", "opponent", "game"))
        self.ids = pool["dk_id"].to_numpy()
        is_ = {p: (pos == p).astype(float) for p in ("QB", "RB", "WR", "TE", "DST")}
        skill = is_["RB"] + is_["WR"] + is_["TE"]
        A, lo, hi = [], [], []

        def add(row, lb, ub):
            A.append(row)
            lo.append(lb)
            hi.append(ub)

        add(pool["salary"].to_numpy().astype(float), r.min_salary, r.salary_cap)
        add(np.ones(n), 9, 9)
        add(is_["QB"], 1, 1)
        add(is_["DST"], 1, 1)
        add(is_["RB"], 2, 3)
        add(is_["WR"], 3, 4)
        add(is_["TE"], 1, 2)
        add(skill, 7, 7)
        for g in np.unique(game):                     # DK: players from at least 2 games
            add((game == g).astype(float), 0, 8)
        for t in np.unique(team):
            on_team = team == t
            add((on_team & (pos != "DST")).astype(float), 0, r.max_per_team)
            for q in np.flatnonzero(on_team & (pos == "QB")):
                if r.qb_stack:                        # Σ own WR/TE ≥ k · x_qb
                    row = (on_team & np.isin(pos, ("WR", "TE"))).astype(float)
                    row[q] = -r.qb_stack
                    add(row, 0, np.inf)
                if r.bring_back:                      # Σ opposing RB/WR/TE ≥ k · x_qb
                    row = ((team == opp[q]) & np.isin(pos, ("RB", "WR", "TE"))).astype(float)
                    row[q] = -r.bring_back
                    add(row, 0, np.inf)
            if r.no_offense_vs_dst:                   # Σ offense facing DST_t ≤ 8 · (1 − x_dst)
                for d in np.flatnonzero(on_team & (pos == "DST")):
                    row = ((opp == t) & (pos != "DST")).astype(float)
                    row[d] = 8
                    add(row, 0, 8)
        self._A, self._lo, self._hi = np.array(A), np.array(lo, float), np.array(hi, float)
        self._lb = np.isin(self.ids, list(r.lock)).astype(float)
        self._ub = 1.0 - np.isin(self.ids, list(r.exclude)).astype(float)

    def solve(
        self, scores: np.ndarray, banned: np.ndarray | None = None,
        previous: list[np.ndarray] | None = None, min_unique: int = 1,
    ) -> np.ndarray | None:
        """Best legal lineup for `scores` → sorted player indices, or None if
        infeasible. `banned`: boolean mask of players to leave out; `previous`:
        lineups the new one must differ from by at least `min_unique` players."""
        A, lo, hi = self._A, self._lo, self._hi
        if previous:
            rows = np.zeros((len(previous), self.n))
            for k, idx in enumerate(previous):
                rows[k, idx] = 1
            A = np.vstack([A, rows])
            lo = np.concatenate([lo, np.zeros(len(previous))])
            hi = np.concatenate([hi, np.full(len(previous), 9 - min_unique)])
        ub = self._ub.copy()
        if banned is not None:
            ub[banned & (self._lb == 0)] = 0
        res = milp(
            c=-np.asarray(scores, float), constraints=LinearConstraint(A, lo, hi),
            integrality=np.ones(self.n), bounds=Bounds(self._lb, ub),
            options={"mip_rel_gap": 1e-6, "time_limit": 20},
        )
        if res.x is None:
            return None
        return np.flatnonzero(res.x > 0.5)


def assign_slots(pool: pl.DataFrame, idx: np.ndarray) -> list[tuple[str, int]]:
    """Order a lineup into DK's slots. The FLEX gets the latest-kicking eligible
    player, which keeps the most late-swap options open."""
    pos, kick = pool["pos"].to_numpy(), pool["kickoff"].to_list()
    by = {p: sorted([i for i in idx if pos[i] == p], key=lambda i: (kick[i] is None, kick[i])) for p in ("QB", "RB", "WR", "TE", "DST")}
    need = {"RB": 2, "WR": 3, "TE": 1}
    extra_pos = next(p for p in need if len(by[p]) > need[p])
    flex = by[extra_pos].pop()   # latest kickoff at the position holding the extra player
    return [
        ("QB", by["QB"][0]), ("RB", by["RB"][0]), ("RB", by["RB"][1]),
        ("WR", by["WR"][0]), ("WR", by["WR"][1]), ("WR", by["WR"][2]),
        ("TE", by["TE"][0]), ("FLEX", flex), ("DST", by["DST"][0]),
    ]
