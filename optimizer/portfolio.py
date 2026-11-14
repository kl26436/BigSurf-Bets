"""Build a *set* of lineups.

One optimal lineup is fragile: its nine players are every entry's nine players.
A portfolio spreads that risk on purpose —

  exposure cap   no player in more than X% of lineups (one injury or dud can't
                 sink the whole night)
  min unique     any two lineups differ by at least K players
  diversity      each lineup is the best answer to a *different simulated
                 Sunday*, not the 2nd/3rd/4th-best answer to the same average one

Two modes:
  cash  (50/50s, head-to-heads): favour the highest expected score; light randomness.
  gpp   (tournaments): stack the QB with a pass catcher, optimise against
        simulated outcomes, and pick each next lineup for what it adds to the
        set's best-case score — lineups that win in worlds the others don't."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import polars as pl

from .classic import SLOTS, Rules, Solver, assign_slots
from .sim import simulate


@dataclass
class Settings:
    n: int = 20
    mode: str = "gpp"                # "gpp" | "cash"
    max_exposure: float = 0.5        # share of lineups any one player may appear in
    min_unique: int = 3              # players by which any two lineups must differ
    candidates: int = 12             # lineups generated per slot, best one kept
    max_mean_drop: float = 0.06      # gpp: never accept a lineup projecting this far below the best one
    n_sims: int = 10_000
    seed: int = 7
    rules: Rules | None = None       # default: by mode

    def resolved_rules(self) -> Rules:
        if self.rules:
            return self.rules
        return Rules(qb_stack=1, min_salary=48_500) if self.mode == "gpp" else Rules(min_salary=49_000)


@dataclass
class Portfolio:
    pool: pl.DataFrame
    settings: Settings
    lineups: list[np.ndarray]              # player indices per lineup
    totals: np.ndarray                     # (n_sims, n_lineups) simulated lineup scores
    notes: list[str] = field(default_factory=list)

    def summary(self) -> pl.DataFrame:
        sal, mean = self.pool["salary"].to_numpy(), self.pool["dk_mean"].to_numpy()
        t = self.totals
        best = t.max(axis=1, keepdims=True)
        return pl.DataFrame({
            "lineup": np.arange(1, len(self.lineups) + 1),
            "salary": [int(sal[i].sum()) for i in self.lineups],
            "proj": [round(float(mean[i].sum()), 2) for i in self.lineups],
            "sim_mean": t.mean(0).round(2), "sim_std": t.std(0).round(2),
            "p10": np.quantile(t, 0.1, axis=0).round(1), "p50": np.quantile(t, 0.5, axis=0).round(1),
            "p90": np.quantile(t, 0.9, axis=0).round(1), "p99": np.quantile(t, 0.99, axis=0).round(1),
            "best_of_set_pct": ((t == best).mean(0) * 100).round(1),
        })

    def rows(self) -> pl.DataFrame:
        """Long form: one row per lineup slot."""
        p = self.pool
        out = []
        for k, idx in enumerate(self.lineups, 1):
            for slot_no, (slot, i) in enumerate(assign_slots(p, idx)):
                out.append(dict(
                    lineup=k, slot_no=slot_no, slot=slot, dk_id=p["dk_id"][int(i)], player_id=p["player_id"][int(i)],
                    name=p["name"][int(i)], pos=p["pos"][int(i)], team=p["team"][int(i)], opponent=p["opponent"][int(i)],
                    salary=int(p["salary"][int(i)]), dk_mean=float(p["dk_mean"][int(i)]), status=p["status"][int(i)],
                ))
        # types from the pool, not inferred: a nullable column (status) can be empty for the
        # first 100 rows and then hold "Q", which breaks polars' schema inference
        cols = ("dk_id", "player_id", "name", "pos", "team", "opponent", "status")
        return pl.DataFrame(out, schema_overrides={c: p.schema[c] for c in cols if c in p.schema},
                            infer_schema_length=None)

    def exposure(self) -> pl.DataFrame:
        r = self.rows()
        return (
            r.group_by("dk_id", "name", "pos", "team", "salary", "dk_mean")
            .agg(pl.len().alias("lineups"))
            .with_columns((pl.col("lineups") / len(self.lineups) * 100).round(0).alias("exposure_pct"))
            .sort("lineups", "dk_mean", descending=True)
        )

    def to_dk_csv(self) -> str:
        """DraftKings bulk-upload format: one lineup per row, player IDs in slot order."""
        r = self.rows().sort("lineup", "slot_no")
        lines = [",".join(SLOTS)]
        for _, g in r.group_by("lineup", maintain_order=True):
            lines.append(",".join(g["dk_id"].to_list()))
        return "\n".join(lines) + "\n"


def build(pool: pl.DataFrame, settings: Settings | None = None, corr: dict | None = None) -> Portfolio:
    s = settings or Settings()
    rng = np.random.default_rng(s.seed)
    sims = simulate(pool, corr, s.n_sims, s.seed)
    mean = pool["dk_mean"].to_numpy().astype(float)
    solver = Solver(pool, s.resolved_rules())
    locked = solver._lb > 0
    cap = max(1, math.floor(s.max_exposure * s.n + 1e-9))
    # how far each candidate's objective leans on one simulated outcome vs the mean
    lam = 0.3 if s.mode == "gpp" else 0.12
    floor = -np.inf
    chosen: list[np.ndarray] = []
    counts = np.zeros(pool.height, int)
    best_so_far = np.full(s.n_sims, -np.inf)
    notes: list[str] = []

    for k in range(s.n):
        banned = (counts >= cap) & ~locked
        cands: dict[tuple, np.ndarray] = {}
        for c in range(s.candidates):
            scores = mean if (c == 0) else (1 - lam) * mean + lam * sims[rng.integers(s.n_sims)]
            idx = solver.solve(scores, banned, chosen, s.min_unique)
            if idx is not None:
                cands[tuple(idx)] = idx
        if not cands:
            notes.append(f"stopped at {k} lineups: no legal lineup left under the exposure/uniqueness limits")
            break
        totals = {key: sims[:, idx].sum(1) for key, idx in cands.items()}
        if not chosen:
            floor = max(t.mean() for t in totals.values()) * (1 - s.max_mean_drop)
        if s.mode == "gpp":  # upside is only worth having on a lineup that is still good on average
            ok = {key: t for key, t in totals.items() if t.mean() >= floor}
            totals = ok or {max(totals, key=lambda key: totals[key].mean()): max(totals.values(), key=lambda t: t.mean())}
        if s.mode == "cash" or not chosen:
            pick = max(totals, key=lambda key: totals[key].mean())
        else:  # what does this lineup add to the set's best score, averaged over simulated Sundays?
            pick = max(totals, key=lambda key: np.maximum(best_so_far, totals[key]).mean())
        chosen.append(cands[pick])
        counts[cands[pick]] += 1
        best_so_far = np.maximum(best_so_far, totals[pick])

    t = np.column_stack([sims[:, idx].sum(1) for idx in chosen]) if chosen else np.empty((s.n_sims, 0))
    return Portfolio(pool, s, chosen, t, notes)
