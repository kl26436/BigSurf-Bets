"""DraftKings salaries. No official API.

Reliable path: the "Export to CSV" link on any contest's draft page →
`bsb dk import-csv path.csv`. Convenience path: the unofficial draftgroups JSON
behind that page (`bsb dk fetch <draftGroupId>`), which may break without notice."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx
import polars as pl
import psycopg
from psycopg.types.json import Jsonb

from .db import RunLogger

log = logging.getLogger(__name__)

DK_TEAM_FIX = {"JAX": "JAX", "LAR": "LA", "WSH": "WAS"}
CLASSIC_ROSTER = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]
SHOWDOWN_ROSTER = ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"]


# SQL: lower-case, drop a trailing generational suffix, keep letters only
_NAME_KEY = (
    "regexp_replace(regexp_replace(lower({col}), '\\s+(jr|sr|ii|iii|iv|v)\\.?$', ''), '[^a-z]', '', 'g')"
)


def _csv_slate_id(is_showdown: bool, starts_at: datetime | None, n_games: int, stem: str) -> str:
    """Stable id for a CSV-imported slate, so re-importing a fresher export of
    the same slate updates it (salaries, statuses) instead of duplicating it."""
    if starts_at is None:
        return f"csv-{stem}"
    return f"csv-{'sd' if is_showdown else 'cl'}-{starts_at:%Y%m%d%H%M}-{n_games}g"


def _team(t: str | None) -> str | None:
    if not t:
        return None
    return DK_TEAM_FIX.get(t.upper(), t.upper())


def _parse_game_info(s: str | None) -> tuple[str | None, str | None, datetime | None]:
    """'DAL@PHI 11/09/2026 01:00PM ET' → (away, home, kickoff_utc)"""
    if not s:
        return None, None, None
    m = re.match(r"(\w+)@(\w+)\s+(\d\d/\d\d/\d{4})\s+(\d\d:\d\d[AP]M)", s)
    if not m:
        return None, None, None
    away, home, d, t = m.groups()
    from zoneinfo import ZoneInfo

    dt = datetime.strptime(f"{d} {t}", "%m/%d/%Y %I:%M%p").replace(
        tzinfo=ZoneInfo("America/New_York")
    )
    return _team(away), _team(home), dt.astimezone(UTC)


def import_csv(
    conn: psycopg.Connection,
    path: str | Path,
    slate_name: str | None = None,
    site_slate_id: str | None = None,
    sport: str = "nfl",
) -> int:
    """Load a DK 'DKSalaries.csv' export. Columns: Position, Name + ID, Name, ID,
    Roster Position, Salary, Game Info, TeamAbbrev, AvgPointsPerGame."""
    with RunLogger(conn, "draftkings.import_csv") as run:
        df = pl.read_csv(path, infer_schema_length=0)
        df.columns = [c.strip() for c in df.columns]
        is_showdown = df["Roster Position"].str.contains("CPT").any()
        games = df["Game Info"].unique().to_list()
        kickoffs = [k for k in (_parse_game_info(g)[2] for g in games) if k]
        starts_at = min(kickoffs) if kickoffs else None
        season_week = conn.execute(
            "select season, week from bsb.games where sport=%s and kickoff_at between %s - interval '1 day' and %s + interval '1 day' limit 1",
            (sport, starts_at, starts_at),
        ).fetchone() if starts_at else None

        slate_id = conn.execute(
            """insert into bsb.dfs_slates (sport, site, slate_type, slate_name, site_slate_id, season, week, starts_at, roster_json)
               values (%s,'draftkings',%s,%s,%s,%s,%s,%s,%s)
               on conflict (site, site_slate_id) do update
                   set slate_name = excluded.slate_name, imported_at = now()
               returning id""",
            (
                sport, "showdown" if is_showdown else "classic",
                slate_name or Path(path).stem,
                site_slate_id or _csv_slate_id(is_showdown, starts_at, len(games), Path(path).stem),
                season_week[0] if season_week else None, season_week[1] if season_week else None,
                starts_at, Jsonb(SHOWDOWN_ROSTER if is_showdown else CLASSIC_ROSTER),
            ),
        ).fetchone()[0]

        # showdown exports list each player twice (CPT at 1.5x salary, FLEX); keep both rows
        # distinct by appending roster position to the site id.
        rows = []
        for r in df.iter_rows(named=True):
            away, home, kick = _parse_game_info(r.get("Game Info"))
            team = _team(r.get("TeamAbbrev"))
            opp = home if team == away else away
            gid = None
            if home and away and kick:
                row = conn.execute(
                    "select game_id from bsb.games where sport=%s and home_team=%s and away_team=%s and kickoff_at between %s - interval '36 hours' and %s + interval '36 hours' limit 1",
                    (sport, home, away, kick, kick),
                ).fetchone()
                gid = row[0] if row else None
            rp = (r.get("Roster Position") or "").split("/")
            sid = r["ID"] + ("-CPT" if "CPT" in rp else "")
            rows.append(
                (
                    slate_id, sid, None, r["Name"], team, opp, r["Position"], rp,
                    int(float(r["Salary"])), float(r.get("AvgPointsPerGame") or 0) or None, gid, Jsonb(r),
                )
            )
        with conn.cursor() as cur:
            cur.executemany(
                """insert into bsb.dfs_salaries
                     (slate_id, site_player_id, player_id, player_name, team, opponent, position,
                      roster_positions, salary, avg_points, game_id, raw)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (slate_id, site_player_id) do update set
                     salary=excluded.salary, avg_points=excluded.avg_points, raw=excluded.raw""",
                rows,
            )
        # map DK names → our player ids on normalized name + team. DK writes
        # "James Cook III" / "Travis Etienne Jr." where nflverse has "James Cook" /
        # "Travis Etienne", so suffixes and punctuation are stripped on both sides.
        conn.execute(
            f"""update bsb.dfs_salaries s set player_id = p.player_id
               from bsb.players p
               where s.slate_id = %s and s.player_id is null and p.sport = %s
                 and {_NAME_KEY.format(col="p.display_name")} = {_NAME_KEY.format(col="s.player_name")}
                 and p.latest_team = s.team and s.position <> 'DST'""",
            (slate_id, sport),
        )
        # DSTs get the synthetic id the projection model writes (DST_<team>)
        conn.execute(
            "update bsb.dfs_salaries set player_id = 'DST_' || team where slate_id = %s and position = 'DST'",
            (slate_id,),
        )
        unmapped = conn.execute(
            "select count(*) from bsb.dfs_salaries where slate_id=%s and player_id is null and position<>'DST'",
            (slate_id,),
        ).fetchone()[0]
        run.rows = len(rows)
        run.detail.update(slate_id=slate_id, showdown=is_showdown, unmapped=unmapped)
        conn.commit()
        return run.rows


# --- unofficial endpoint (may break) ---------------------------------------

def fetch_draftgroup(draft_group_id: int) -> dict:
    url = f"https://api.draftkings.com/draftgroups/v1/draftgroups/{draft_group_id}/draftables"
    r = httpx.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    return r.json()


def draftgroup_to_csv(data: dict, out: Path) -> Path:
    """Convert the draftables JSON into the same shape as the CSV export so one
    import path handles both."""
    recs = []
    for d in data.get("draftables", []):
        comp = d.get("competition") or {}
        recs.append(
            {
                "Position": d.get("position"),
                "Name + ID": f"{d.get('displayName')} ({d.get('playerId')})",
                "Name": d.get("displayName"),
                "ID": str(d.get("playerId")),
                "Roster Position": d.get("rosterSlotId"),
                "Salary": d.get("salary"),
                "Game Info": comp.get("name", "").replace(" ", "") + " " + comp.get("startTime", ""),
                "TeamAbbrev": d.get("teamAbbreviation"),
                "AvgPointsPerGame": next(
                    (s.get("value") for s in d.get("draftStatAttributes", []) if s.get("id") == 90), None
                ),
            }
        )
    pl.DataFrame(recs).write_csv(out)
    return out
