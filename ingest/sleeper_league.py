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


def snapshot_league(conn: psycopg.Connection, league_id: str, my_username: str | None = None) -> int:
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
        run.rows = insert_df(conn, "fantasy_roster_snapshots", pl.DataFrame(rows, infer_schema_length=None))
        run.detail.update(league=lg.get("name"), week=week, rosters=len(rows))
        conn.commit()
        return run.rows
