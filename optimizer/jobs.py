"""Lineup builds requested by the app (bsb.app_jobs, kind = build_lineups).

The payload carries DraftKings ids, not names: the app picks players from the
same slate the optimizer reads, so ids are exact."""

from __future__ import annotations

from typing import Any

from . import portfolio, showdown, slate, store
from .classic import Rules


class JobError(Exception):
    """A request that cannot be carried out (bad input, nothing to build from)."""


def _num(payload: dict, key: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(payload.get(key, default))
    except (TypeError, ValueError) as e:
        raise JobError(f"{key} must be a number") from e
    if not lo <= v <= hi:
        raise JobError(f"{key} must be between {lo:g} and {hi:g}")
    return v


def auto_set_is_current(conn, slate_id: int, mode: str, run_id: int | None) -> bool:
    """True when the newest automatic set for this slate and mode was already
    built from the newest projections and no override has changed since."""
    row = conn.execute(
        """select ls.run_id, ls.created_at,
                  (select max(o.updated_at) from bsb.projection_overrides o
                   join bsb.dfs_slates sl on sl.id = ls.slate_id and o.season = sl.season and o.week = sl.week)
           from bsb.lineup_sets ls
           where ls.slate_id = %s and ls.mode = %s and ls.source = 'auto'
           order by ls.created_at desc limit 1""",
        (slate_id, mode),
    ).fetchone()
    return bool(row) and row[0] == run_id and (row[2] is None or row[2] < row[1])


def showdown_set(pool, st: portfolio.Settings, lock: set[str], exclude: set[str], min_salary: int = 0,
                 captain: set[str] | None = None) -> showdown.ShowdownPortfolio:
    """A single-game (captain) set. The classic strategy rules do not apply; what
    is recorded with the set is only what was used."""
    st.rules = Rules(min_salary=min_salary, lock=lock, exclude=exclude, no_offense_vs_dst=False)
    return showdown.build(pool, st, showdown.Rules(min_salary=min_salary, lock=lock, exclude=exclude, captain=captain or set()))


def build_lineups(conn, job_id: int, payload: dict[str, Any]) -> dict:
    """Build the set a build_lineups job asks for and store it (source = 'user')."""
    slate_id = payload.get("slate_id") or slate.latest_slate_id(conn)
    if slate_id is None:
        raise JobError("there is no upcoming DraftKings slate to build from")
    mode = payload.get("mode", "gpp")
    if mode not in ("gpp", "cash"):
        raise JobError("mode must be gpp or cash")
    pool, info = slate.from_db(conn, int(slate_id))
    if pool.is_empty():
        raise JobError("no projected players on this slate yet")
    single = info.get("slate_type") == "showdown"
    n = int(_num(payload, "n", 10 if single else 20, 1, 150))
    st = portfolio.Settings(
        n=n, mode=mode, max_exposure=_num(payload, "max_exposure", 0.6 if single else 0.5, 0.01, 1),
        min_unique=int(_num(payload, "min_unique", 2 if single else 3, 1, 5 if single else 8)), seed=int(_num(payload, "seed", 7, 0, 1e9)),
    )
    known = set(pool["dk_id"].to_list())
    lock = {str(x) for x in payload.get("lock") or []}
    exclude = {str(x) for x in payload.get("exclude") or []}
    gone = sorted(lock - known)
    label = (payload.get("label") or "").strip()[:60] or None
    if single:
        if len(lock & known) > 6:
            raise JobError("more than six players are locked")
        captain = {str(x) for x in payload.get("captain") or []} & known
        pf = showdown_set(pool, st, lock & known, exclude & known, int(_num(payload, "min_salary", 0, 0, 50_000)), captain)
        if not pf.lineups:
            raise JobError("no legal lineup under these rules: " + "; ".join(pf.notes or ["locks and limits conflict"]))
        if gone:
            pf.notes.append(f"{len(gone)} locked player(s) are no longer playable on this slate and were ignored")
        set_id = store.write_db(conn, pf, info["id"], info.get("run_id"), source="user", job_id=job_id, label=label)
        return {"set_id": set_id, "slate_id": info["id"], "n_lineups": len(pf.lineups), "notes": pf.notes, **store.set_summary(pf)}
    if len(lock & known) > 9:
        raise JobError("more than nine players are locked")
    over: dict[str, Any] = {}
    if "qb_stack" in payload:
        over["qb_stack"] = int(_num(payload, "qb_stack", 1, 0, 4))
    if "bring_back" in payload:
        over["bring_back"] = int(_num(payload, "bring_back", 0, 0, 2))
    if "max_per_team" in payload:
        over["max_per_team"] = int(_num(payload, "max_per_team", 5, 1, 8))
    if "min_salary" in payload:
        over["min_salary"] = int(_num(payload, "min_salary", 48_500, 0, 50_000))
    st.rules = Rules(**{**st.resolved_rules().__dict__, **over, "lock": lock & known, "exclude": exclude & known})
    pf = portfolio.build(pool, st)
    if not pf.lineups:
        raise JobError("no legal lineup under these rules: " + "; ".join(pf.notes or ["locks and limits conflict"]))
    if gone:
        pf.notes.append(f"{len(gone)} locked player(s) are no longer playable on this slate and were ignored")
    set_id = store.write_db(conn, pf, info["id"], info.get("run_id"), source="user", job_id=job_id, label=label)
    return {"set_id": set_id, "slate_id": info["id"], "n_lineups": len(pf.lineups), "notes": pf.notes, **store.set_summary(pf)}
