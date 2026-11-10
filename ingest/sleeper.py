"""Sleeper public API — free, keyless. Best free source for near-real-time
injury status (Out / Doubtful / Questionable / IR) and depth chart order.

Docs: https://docs.sleeper.com  (players endpoint is ~5 MB; call at most daily
for the full map, and use it to populate players.sleeper_id)."""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from datetime import UTC, datetime

import httpx
import polars as pl
import psycopg

from .db import RunLogger, insert_df

log = logging.getLogger(__name__)
BASE = "https://api.sleeper.app/v1"
ACTIVE_POS = {"QB", "RB", "WR", "TE", "K", "DEF"}
TEAM_FIX = {"LAR": "LA", "WSH": "WAS", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LA"}


def norm_name(s: str | None) -> str:
    """Lower-case letters only, generational suffix dropped ('Marvin Harrison Jr.' → 'marvinharrison')."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?$", "", s.strip()))


class IdResolver:
    """Sleeper player → our player_id (nflverse gsis_id).

    Sleeper carries a gsis_id for only about one player in five, so matching on
    it alone silently dropped most injury statuses. Order of preference: the id
    Sleeper gives, a sleeper_id we mapped before, name + team, then name +
    position when that is unambiguous."""

    def __init__(self, conn: psycopg.Connection, sport: str = "nfl"):
        rows = conn.execute(
            """select player_id, display_name, latest_team, position, sleeper_id, status
               from bsb.players where sport = %s and position in ('QB','RB','WR','TE','K','FB')""",
            (sport,),
        ).fetchall()
        self.known = {r[0] for r in rows}
        self.by_sleeper = {r[4]: r[0] for r in rows if r[4]}
        self.by_team: dict[tuple[str, str], list[str]] = {}
        self.by_pos: dict[tuple[str, str], list[str]] = {}
        for pid, name, team, pos, _sid, status in rows:
            key = norm_name(name)
            if not key:
                continue
            if team:
                self.by_team.setdefault((key, team), []).append(pid)
            if status in ("ACT", "RES", "DEV", "INA", "RSR", "RSN", None):   # still in the league
                self.by_pos.setdefault((key, "RB" if pos == "FB" else pos), []).append(pid)

    def resolve(self, sleeper_id: str, p: dict) -> tuple[str | None, str]:
        gsis = (p.get("gsis_id") or "").strip()
        if gsis and gsis in self.known:
            return gsis, "gsis"
        if sleeper_id in self.by_sleeper:
            return self.by_sleeper[sleeper_id], "sleeper_id"
        key = norm_name(p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}")
        team = TEAM_FIX.get(p.get("team") or "", p.get("team"))
        hit = self.by_team.get((key, team), [])
        if len(hit) == 1:
            return hit[0], "name_team"
        hit = self.by_pos.get((key, p.get("position")), [])
        if len(hit) == 1:
            return hit[0], "name_pos"
        return None, "none"


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
        ids = IdResolver(conn, sport)
        now = datetime.now(UTC)
        rows, id_map, how = [], [], Counter()
        for sid, p in players.items():
            pos = p.get("position")
            if pos not in ACTIVE_POS or not p.get("team"):
                continue
            pid, method = (None, "def") if pos == "DEF" else ids.resolve(sid, p)
            how[method] += 1
            if pid:
                id_map.append((sid, pid))
            rows.append(
                {
                    "sport": sport,
                    "source": "sleeper",
                    "captured_at": now,
                    "player_id": pid,
                    "source_player_id": sid,
                    "team": TEAM_FIX.get(p.get("team"), p.get("team")),
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

        # remember sleeper ids on our players table (league rosters are keyed by them)
        with conn.cursor() as cur:
            cur.executemany(
                "update bsb.players set sleeper_id = %s where sport = %s and player_id = %s and sleeper_id is distinct from %s",
                [(sid, sport, pid, sid) for sid, pid in id_map],
            )
        # earlier snapshots were written before name matching existed: fill them in
        conn.execute(
            """update bsb.player_status_snapshots s set player_id = p.player_id
               from bsb.players p
               where s.player_id is null and s.source = 'sleeper' and p.sport = %s and p.sleeper_id = s.source_player_id""",
            (sport,),
        )
        skill = [r for r in rows if r["position"] in ("QB", "RB", "WR", "TE")]
        flagged = [r for r in skill if r["injury_status"]]
        run.detail.update(
            id_mapped=len(id_map), matched_by=dict(how),
            skill_mapped_pct=round(100 * sum(1 for r in skill if r["player_id"]) / max(len(skill), 1), 1),
            injured_mapped_pct=round(100 * sum(1 for r in flagged if r["player_id"]) / max(len(flagged), 1), 1),
        )
        conn.commit()
        return run.rows
