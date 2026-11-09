"""Shared odds helpers: price conversion, canonical bookmaker slugs, game matching."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import psycopg

log = logging.getLogger(__name__)

# provider slug → our canonical slug (bsb.bookmakers)
BOOK_ALIASES = {
    "pinnacle": "pinnacle",
    "circa": "circa",
    "circasports": "circa",
    "circa_sports": "circa",
    "draftkings": "draftkings",
    "betmgm": "betmgm",
    "fanduel": "fanduel",
    "caesars": "caesars",
}

# Common team-name spellings → nflverse abbreviations
TEAM_NAMES = {
    "arizona cardinals": "ARI", "atlanta falcons": "ATL", "baltimore ravens": "BAL",
    "buffalo bills": "BUF", "carolina panthers": "CAR", "chicago bears": "CHI",
    "cincinnati bengals": "CIN", "cleveland browns": "CLE", "dallas cowboys": "DAL",
    "denver broncos": "DEN", "detroit lions": "DET", "green bay packers": "GB",
    "houston texans": "HOU", "indianapolis colts": "IND", "jacksonville jaguars": "JAX",
    "kansas city chiefs": "KC", "las vegas raiders": "LV", "los angeles chargers": "LAC",
    "los angeles rams": "LA", "miami dolphins": "MIA", "minnesota vikings": "MIN",
    "new england patriots": "NE", "new orleans saints": "NO", "new york giants": "NYG",
    "new york jets": "NYJ", "philadelphia eagles": "PHI", "pittsburgh steelers": "PIT",
    "san francisco 49ers": "SF", "seattle seahawks": "SEA", "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN", "washington commanders": "WAS",
}


def team_abbr(name: str | None) -> str | None:
    if not name:
        return None
    n = name.strip().lower()
    if n in TEAM_NAMES:
        return TEAM_NAMES[n]
    # fall back on nickname match ("Cowboys", "49ers")
    for full, abbr in TEAM_NAMES.items():
        if n == full.split()[-1] or n == full:
            return abbr
    return None


def canonical_book(slug: str) -> str | None:
    return BOOK_ALIASES.get(slug.lower().replace(" ", "").replace("-", "_"))


def decimal_to_american(d: float) -> int:
    if d >= 2.0:
        return round((d - 1) * 100)
    return round(-100 / (d - 1))


def american_to_decimal(a: int) -> float:
    return 1 + a / 100 if a > 0 else 1 + 100 / abs(a)


def match_game_id(
    conn: psycopg.Connection,
    home: str | None,
    away: str | None,
    start: datetime | None,
    sport: str = "nfl",
    window_hours: int = 36,
) -> str | None:
    """Find our games.game_id for a provider fixture by team pair + kickoff window."""
    if not (home and away):
        return None
    params: list = [sport, home, away]
    q = "select game_id from bsb.games where sport = %s and home_team = %s and away_team = %s"
    if start is not None:
        q += " and kickoff_at between %s and %s"
        params += [start - timedelta(hours=window_hours), start + timedelta(hours=window_hours)]
    q += " order by kickoff_at desc limit 1"
    row = conn.execute(q, params).fetchone()
    return row[0] if row else None


def upcoming_games(conn: psycopg.Connection, days: int = 8, sport: str = "nfl") -> list[dict]:
    now = datetime.now(UTC)
    rows = conn.execute(
        """select game_id, home_team, away_team, kickoff_at, season, week
           from bsb.games where sport = %s and kickoff_at between %s and %s
           order by kickoff_at""",
        (sport, now - timedelta(hours=6), now + timedelta(days=days)),
    ).fetchall()
    return [
        dict(game_id=r[0], home_team=r[1], away_team=r[2], kickoff_at=r[3], season=r[4], week=r[5])
        for r in rows
    ]
