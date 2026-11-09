"""OddsPapi v4 client (free tier: 250 req/month). Kevin's key is a v4 key —
v5 (docs.oddspapi.io) rejects it with invalid_api_key.

Base: https://api.oddspapi.io/v4   Auth: ?apiKey=   Docs: https://oddspapi.io/en/docs

One snapshot = 3 discovery calls + 1 call per bookmaker:
  /tournaments?sportId=14            → NFL tournamentId
  /fixtures?tournamentId=..&from&to  → fixtureId, team names, startTime
  /markets                           → marketId → name/type/period/playerProp
  /odds-by-tournaments?bookmaker=B&tournamentIds=T   (×N bookmakers)

Odds nest as bookmakerOdds→{book}→markets→{marketId}→outcomes→{outcomeId}→
players→{idx}→{price, priceAmerican, playerName, mainLine, active,
bookmakerOutcomeId e.g. "3.5/over"}.

Endpoints have 0.5–2s cooldowns, so we sleep between calls."""

from __future__ import annotations

import logging
import re
import time
from datetime import UTC, datetime, timedelta

import httpx
import polars as pl
import psycopg

from .db import RunLogger, insert_df
from .odds_common import canonical_book, match_game_id, team_abbr

log = logging.getLogger(__name__)
BASE = "https://api.oddspapi.io/v4"
SPORT_ID_AMERICAN_FOOTBALL = 14
COOLDOWN_S = 2.1  # longest documented endpoint cooldown is 2000ms


class OddsPapi:
    def __init__(self, api_key: str):
        self.key = api_key
        self.h = httpx.Client(base_url=BASE, timeout=60)
        self.calls = 0
        self._last = 0.0

    def get(self, path: str, **params):
        wait = COOLDOWN_S - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        q = {k: v for k, v in params.items() if v is not None}
        q["apiKey"] = self.key
        r = self.h.get(path, params=q)
        self._last = time.monotonic()
        self.calls += 1
        if r.status_code >= 400:
            raise RuntimeError(f"{r.status_code} from {path}: {r.text[:300]}")
        return r.json()

    def sports(self) -> list[dict]:
        return self.get("/sports")

    def bookmakers(self) -> list[dict]:
        return self.get("/bookmakers")

    def tournaments(self, sport_id: int = SPORT_ID_AMERICAN_FOOTBALL) -> list[dict]:
        return self.get("/tournaments", sportId=sport_id)

    def nfl_tournament_id(self) -> int:
        for t in self.tournaments():
            name = (t.get("tournamentName") or "").lower()
            slug = (t.get("tournamentSlug") or "").lower()
            if slug == "nfl" or name == "nfl" or "national football league" in name:
                return int(t["tournamentId"])
        raise RuntimeError("NFL not found in OddsPapi sportId=14 tournaments")

    def fixtures(self, tournament_id: int, start: datetime, end: datetime) -> list[dict]:
        fmt = "%Y-%m-%dT%H:%M:%SZ"
        return self.get(
            "/fixtures", tournamentId=tournament_id,
            **{"from": start.strftime(fmt), "to": end.strftime(fmt)},
        )

    def markets(self) -> dict[int, dict]:
        return {int(m["marketId"]): m for m in self.get("/markets")}

    def odds_by_tournament(self, tournament_id: int, bookmaker: str) -> list[dict]:
        return self.get("/odds-by-tournaments", tournamentIds=tournament_id, bookmaker=bookmaker)


# ---------------------------------------------------------------------------

_LINE_RE = re.compile(r"^(-?\d+(?:\.\d+)?)/(.+)$")


def _parse_outcome(
    mkt: dict | None, outcome_id: int, entry: dict, home: str | None, away: str | None
) -> tuple[str, str, str, str | None, float | None]:
    """→ (market, period, outcome, prop_type, line)"""
    mtype = (mkt or {}).get("marketType", "") or ""
    mname = (mkt or {}).get("marketName", "") or ""
    period = ((mkt or {}).get("period") or "fulltime").lower()
    period = {"fulltime": "full", "1st half": "1h", "2nd half": "2h"}.get(period, period)
    oname = ""
    for o in (mkt or {}).get("outcomes", []) or []:
        if int(o.get("outcomeId", -1)) == outcome_id:
            oname = (o.get("outcomeName") or "").lower()
            break
    # line: prefer the bookmaker outcome id ("3.5/over", "-2.5/home"), else market handicap
    line = None
    boid = str(entry.get("bookmakerOutcomeId") or "")
    m = _LINE_RE.match(boid)
    if m:
        line = float(m.group(1))
        if not oname:
            oname = m.group(2).lower()
    elif (mkt or {}).get("handicap") not in (None, 0):
        line = float(mkt["handicap"])

    def side(o: str) -> str:
        if o in ("1", "home") or o == (home or "").lower():
            return "home"
        if o in ("2", "away") or o == (away or "").lower():
            return "away"
        return o

    if (mkt or {}).get("playerProp"):
        outcome = "over" if "over" in oname else "under" if "under" in oname else oname or "yes"
        return "player_prop", period, outcome, mname.lower().replace(" ", "_"), line
    if mtype in ("1x2", "moneyline", "12", "winner") or "result" in mname.lower() and line is None:
        return "moneyline", period, side(oname), None, None
    if mtype in ("handicap", "spread") or "handicap" in mname.lower() or "spread" in mname.lower():
        return "spread", period, side(oname), None, line
    if mtype == "totals" or "over under" in mname.lower() or "total" in mname.lower():
        return "total", period, "over" if "over" in oname else "under" if "under" in oname else oname, None, line
    return (mtype or mname.lower().replace(" ", "_") or f"market_{(mkt or {}).get('marketId', '?')}"), period, oname, None, line


def snapshot_upcoming(
    conn: psycopg.Connection, api_key: str, bookmakers: list[str], days: int = 7, sport: str = "nfl"
) -> int:
    api = OddsPapi(api_key)
    with RunLogger(conn, "odds.oddspapi") as run:
        tid = api.nfl_tournament_id()
        now = datetime.now(UTC)
        fixtures = {str(f["fixtureId"]): f for f in api.fixtures(tid, now, now + timedelta(days=days))}
        mkts = api.markets()

        # map provider fixtures → our games once
        fx_meta: dict[str, dict] = {}
        for fid, f in fixtures.items():
            # OddsPapi lists home as participant1 for US sports? Not guaranteed — match both orders.
            p1 = team_abbr(f.get("participant1Name")) or (f.get("participant1Abbr") or "").upper() or None
            p2 = team_abbr(f.get("participant2Name")) or (f.get("participant2Abbr") or "").upper() or None
            start = f.get("startTime")
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00")) if start else None
            gid = match_game_id(conn, p1, p2, start_dt, sport)
            home, away = p1, p2
            if gid is None:
                gid = match_game_id(conn, p2, p1, start_dt, sport)
                if gid is not None:
                    home, away = p2, p1
            fx_meta[fid] = {"game_id": gid, "home": home, "away": away}

        rows: list[dict] = []
        errors: dict[str, str] = {}
        for book in bookmakers:
            cb = canonical_book(book) or book
            try:
                data = api.odds_by_tournament(tid, book)
            except Exception as e:  # unknown slug / not entitled — keep going with the others
                errors[book] = str(e)[:200]
                log.warning("oddspapi %s: %s", book, e)
                continue
            captured = datetime.now(UTC)
            for f in data:
                fid = str(f.get("fixtureId"))
                meta = fx_meta.get(fid) or {"game_id": None, "home": None, "away": None}
                for bslug, bo in (f.get("bookmakerOdds") or {}).items():
                    for mid, m in (bo.get("markets") or {}).items():
                        mkt = mkts.get(int(mid))
                        for oid, o in (m.get("outcomes") or {}).items():
                            for _idx, e in (o.get("players") or {}).items():
                                if not e.get("active", True) or e.get("price") in (None, 0):
                                    continue
                                market, period, outcome, prop, line = _parse_outcome(
                                    mkt, int(oid), e, meta["home"], meta["away"]
                                )
                                price = float(e["price"])
                                pa = e.get("priceAmerican")
                                rows.append(
                                    dict(
                                        sport=sport, captured_at=captured, provider="oddspapi",
                                        provider_fixture_id=fid, game_id=meta["game_id"],
                                        bookmaker=cb, market=market, period=period,
                                        player_id=None, prop_type=prop, outcome=outcome, line=line,
                                        price_decimal=price,
                                        price_american=int(str(pa).replace("+", "")) if pa not in (None, "") else None,
                                        is_live=False,
                                        raw={
                                            "marketId": int(mid), "outcomeId": int(oid),
                                            "bookmakerOutcomeId": e.get("bookmakerOutcomeId"),
                                            "playerName": e.get("playerName"),
                                            "mainLine": e.get("mainLine"), "limit": e.get("limit"),
                                            "changedAt": e.get("changedAt"), "book_raw": bslug,
                                        },
                                    )
                                )
        if rows:
            run.rows = insert_df(conn, "odds_snapshots", pl.DataFrame(rows))
        unmatched = sum(1 for m in fx_meta.values() if m["game_id"] is None)
        run.detail.update(
            fixtures=len(fixtures), unmatched_fixtures=unmatched, api_calls=api.calls,
            books=bookmakers, book_errors=errors or None,
        )
        conn.commit()
        return run.rows
