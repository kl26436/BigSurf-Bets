"""Sleeper public API — free, keyless. Best free source for near-real-time
injury status (Out / Doubtful / Questionable / IR) and depth chart order.

Docs: https://docs.sleeper.com  (players endpoint is ~5 MB; call at most daily
for the full map, and use it to populate players.sleeper_id)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx
import polars as pl
import psycopg

from .db import RunLogger, insert_df

log = logging.getLogger(__name__)
BASE = "https://api.sleeper.app/v1"
ACTIVE_POS = {"QB", "RB", "WR", "TE", "K", "DEF"}


def fetch_players() -> dict[str, dict]:
    r = httpx.get(f"{BASE}/players/nfl", timeout=60)
    r.raise_for_status()
    return r.json()


def fetch_state() -> dict:
    r = httpx.get(f"{BASE}/state/nfl", timeout=30)
    r.raise_for_status()
    return r.json()


def snapshot_status(conn: psycopg.Connection, sport: str = "nfl") -> int:
    """Append one row per relevant player with their current Sleeper status, and
    backfill players.sleeper_id where the gsis_id matches."""
    with RunLogger(conn, "sleeper.status") as run:
        players = fetch_players()
        now = datetime.now(UTC)
        rows, id_map = [], []
        for sid, p in players.items():
            pos = p.get("position")
            if pos not in ACTIVE_POS or not p.get("team"):
                continue
            gsis = p.get("gsis_id")
            if gsis:
                id_map.append((sid, gsis.strip()))
            rows.append(
                {
                    "sport": sport,
                    "source": "sleeper",
                    "captured_at": now,
                    "player_id": gsis.strip() if gsis else None,
                    "source_player_id": sid,
                    "team": p.get("team"),
                    "position": pos,
                    "injury_status": p.get("injury_status"),
                    "injury_body_part": p.get("injury_body_part"),
                    "injury_notes": p.get("injury_notes"),
                    "depth_chart_order": p.get("depth_chart_order"),
                    "raw": {
                        k: p.get(k)
                        for k in (
                            "full_name", "status", "active", "practice_participation",
                            "practice_description", "injury_start_date", "news_updated",
                            "depth_chart_position", "years_exp", "number",
                        )
                    },
                }
            )
        df = pl.DataFrame(rows, infer_schema_length=None)
        run.rows = insert_df(conn, "player_status_snapshots", df)

        # map sleeper ids onto our players table
        with conn.cursor() as cur:
            cur.executemany(
                "update bsb.players set sleeper_id = %s where sport = %s and player_id = %s and sleeper_id is distinct from %s",
                [(sid, sport, gsis, sid) for sid, gsis in id_map],
            )
        run.detail["id_mapped"] = len(id_map)
        conn.commit()
        return run.rows
