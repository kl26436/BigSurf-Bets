"""Sleeper fantasy league ingestion — rosters, matchups, league settings.
Free, keyless. Needs only a username or league_id.

Phase 1 use: pull Kevin's guillotine-league roster + the free-agent pool so
the projection model can rank start/sit and waiver targets."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx
import polars as pl
import psycopg

from .db import RunLogger, insert_df
from .sleeper import BASE, fetch_state

log = logging.getLogger(__name__)


def _get(path: str):
    r = httpx.get(f"{BASE}{path}", timeout=30)
    r.raise_for_status()
    return r.json()


def user_id(username: str) -> str:
    return _get(f"/user/{username}")["user_id"]


def leagues_for_user(username: str, season: int | None = None) -> list[dict]:
    season = season or int(fetch_state()["season"])
    return _get(f"/user/{user_id(username)}/leagues/nfl/{season}")


def league(league_id: str) -> dict:
    return _get(f"/league/{league_id}")


def rosters(league_id: str) -> list[dict]:
    return _get(f"/league/{league_id}/rosters")


def users(league_id: str) -> list[dict]:
    return _get(f"/league/{league_id}/users")


def matchups(league_id: str, week: int) -> list[dict]:
    return _get(f"/league/{league_id}/matchups/{week}")


def transactions(league_id: str, week: int) -> list[dict]:
    return _get(f"/league/{league_id}/transactions/{week}")


def _ts(ms) -> datetime | None:
    return datetime.fromtimestamp(ms / 1000, UTC) if ms else None


def transaction_rows(league_id: str, txs: list[dict]) -> list[tuple]:
    """Sleeper transactions → rows for bsb.fantasy_transactions. A waiver claim
    adds exactly one player; `adds` maps player id → roster id."""
    rows = []
    for t in txs:
        adds, drops = t.get("adds") or {}, t.get("drops") or {}
        add = next(iter(adds), None)
        roster = adds.get(add) if add else (next(iter(t.get("roster_ids") or []), None))
        rows.append((
            str(t["transaction_id"]), league_id, t.get("leg"), t.get("type") or "?", t.get("status"), roster, add,
            next(iter(drops), None), (t.get("settings") or {}).get("waiver_bid"),
            psycopg.types.json.Jsonb(adds), psycopg.types.json.Jsonb(drops),
            _ts(t.get("created")), _ts(t.get("status_updated")), (t.get("metadata") or {}).get("notes"),
        ))
    return rows


def snapshot_transactions(conn: psycopg.Connection, league_id: str, through_week: int) -> tuple[int, int]:
    """Every transaction of the season so far (waiver bids won and lost, chops).
    Returns (seen, new or changed). Needs migration 0010; skipped quietly before
    it is applied."""
    if not conn.execute("select to_regclass('bsb.fantasy_transactions')").fetchone()[0]:
        return 0, 0
    n = changed = 0
    for week in range(1, max(through_week, 1) + 2):
        rows = transaction_rows(league_id, transactions(league_id, week))
        for row in rows:
            cur = conn.execute(
                """insert into bsb.fantasy_transactions (transaction_id, league_id, leg, type, status, roster_id,
                       player_id, drop_player_id, bid, adds, drops, created, status_updated, note)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (transaction_id) do update set status = excluded.status,
                       status_updated = excluded.status_updated, note = excluded.note
                   where (bsb.fantasy_transactions.status, bsb.fantasy_transactions.status_updated, bsb.fantasy_transactions.note)
                         is distinct from (excluded.status, excluded.status_updated, excluded.note)""",
                row,
            )
            changed += cur.rowcount
        n += len(rows)
    return n, changed


def _roster_key(r: dict) -> tuple:
    """What makes two looks at a roster different: who is on it, who starts, the record and the points."""
    return (r["roster_id"], r.get("owner_user_id"), bool(r.get("is_me")), tuple(r.get("starters") or []),
            tuple(sorted(r.get("players") or [])), tuple(sorted(r.get("reserve") or [])),
            r.get("wins"), r.get("losses"), round(float(r.get("fpts") or 0), 2), r.get("week"))


def rosters_changed(conn: psycopg.Connection, league_id: str, rows: list[dict]) -> bool:
    """Do these rosters differ from the newest snapshot on file?"""
    last = conn.execute(
        """select roster_id, owner_user_id, is_me, starters, players, reserve, wins, losses, fpts, week
           from bsb.fantasy_roster_snapshots
           where league_id = %s and captured_at = (select max(captured_at) from bsb.fantasy_roster_snapshots where league_id = %s)""",
        (league_id, league_id),
    ).fetchall()
    cols = ("roster_id", "owner_user_id", "is_me", "starters", "players", "reserve", "wins", "losses", "fpts", "week")
    return {_roster_key(dict(zip(cols, r, strict=True))) for r in last} != {_roster_key(r) for r in rows}


def ensure_schema(conn: psycopg.Connection) -> None:
    conn.execute(
        """
        create table if not exists bsb.fantasy_leagues (
            league_id   text primary key,
            platform    text not null default 'sleeper',
            name        text,
            season      int,
            total_rosters int,
            scoring     jsonb,
            roster_positions text[],
            settings    jsonb,
            updated_at  timestamptz not null default now()
        );
        create table if not exists bsb.fantasy_roster_snapshots (
            id            bigserial primary key,
            league_id     text not null references bsb.fantasy_leagues(league_id),
            captured_at   timestamptz not null default now(),
            week          int,
            roster_id     int not null,
            owner_user_id text,
            owner_name    text,
            is_me         boolean not null default false,
            starters      text[],       -- sleeper player ids
            players       text[],
            reserve       text[],
            wins int, losses int, fpts numeric(8,2),
            raw           jsonb
        );
        create index if not exists frs_league_idx on bsb.fantasy_roster_snapshots (league_id, captured_at desc);
        """
    )


def snapshot_league(conn: psycopg.Connection, league_id: str, my_username: str | None = None) -> bool:
    """Read the league from Sleeper. True when rosters, lineups or transactions changed since the last look."""
    with RunLogger(conn, "sleeper.league") as run:
        ensure_schema(conn)
        lg = league(league_id)
        state = fetch_state()
        week = int(state.get("week") or 0)
        conn.execute(
            """insert into bsb.fantasy_leagues
                 (league_id, name, season, total_rosters, scoring, roster_positions, settings)
               values (%s,%s,%s,%s,%s,%s,%s)
               on conflict (league_id) do update set
                 name=excluded.name, season=excluded.season, total_rosters=excluded.total_rosters,
                 scoring=excluded.scoring, roster_positions=excluded.roster_positions,
                 settings=excluded.settings, updated_at=now()""",
            (
                league_id, lg.get("name"), int(lg.get("season") or 0), lg.get("total_rosters"),
                psycopg.types.json.Jsonb(lg.get("scoring_settings") or {}),
                lg.get("roster_positions"), psycopg.types.json.Jsonb(lg.get("settings") or {}),
            ),
        )
        me = user_id(my_username) if my_username else None
        owners = {u["user_id"]: u.get("display_name") for u in users(league_id)}
        now = datetime.now(UTC)
        rows = []
        for r in rosters(league_id):
            s = r.get("settings") or {}
            rows.append(
                {
                    "league_id": league_id,
                    "captured_at": now,
                    "week": week,
                    "roster_id": r["roster_id"],
                    "owner_user_id": r.get("owner_id"),
                    "owner_name": owners.get(r.get("owner_id")),
                    "is_me": r.get("owner_id") == me,
                    "starters": r.get("starters") or [],
                    "players": r.get("players") or [],
                    "reserve": r.get("reserve") or [],
                    "wins": s.get("wins"),
                    "losses": s.get("losses"),
                    "fpts": (s.get("fpts") or 0) + (s.get("fpts_decimal") or 0) / 100,
                    "raw": r,
                }
            )
        # Pulled every hour: keep a new snapshot only when something moved, so the
        # table grows with the league's activity and not with the clock.
        moved = rosters_changed(conn, league_id, rows)
        if moved:
            run.rows = insert_df(conn, "fantasy_roster_snapshots", pl.DataFrame(rows, infer_schema_length=None))
        txs, tx_changed = snapshot_transactions(conn, league_id, week)
        changed = moved or tx_changed > 0
        run.detail.update(league=lg.get("name"), week=week, rosters=len(rows), transactions=txs,
                          new_transactions=tx_changed, changed=changed)
        conn.commit()
        return changed
