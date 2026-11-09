"""OddsPapi client (free tier: 250 req/month; one request = full board for a
fixture incl. Pinnacle). Base: https://v5.oddspapi.io/en  Auth: X-API-Key.

Budget plan: ~16 NFL games/week × 2 snapshots (Sat night + Sun morning) ≈ 32
req/week ≈ 140/month, leaving headroom for props on showdown slates.

Response shape (fixtures/odds):
  {"odds": {"<book>": {"<fixtureId>:<book>:<outcomeId>:<playerId>": {"price":..}}},
   "bookmakers": {...}}
Market/handicap resolution requires GET /markets?outcomeIds=... — we cache that."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx
import polars as pl
import psycopg

from .db import RunLogger, insert_df
from .odds_common import canonical_book, decimal_to_american, match_game_id, team_abbr

log = logging.getLogger(__name__)
BASE = "https://v5.oddspapi.io/en"
SPORT_ID_AMERICAN_FOOTBALL = 14


class OddsPapi:
    def __init__(self, api_key: str):
        self.h = httpx.Client(base_url=BASE, headers={"X-API-Key": api_key}, timeout=60)
        self.calls = 0

    def get(self, path: str, **params):
        r = self.h.get(path, params={k: v for k, v in params.items() if v is not None})
        self.calls += 1
        if r.status_code >= 400:
            raise RuntimeError(f"{r.status_code} from {r.url.path}: {r.text[:300]}")
        return r.json()

    # --- discovery (free-ish; still counts toward quota, so cache results) ---

    def bookmakers(self) -> list[dict]:
        return self.get("/bookmakers")

    def tournaments(self, sport_id: int = SPORT_ID_AMERICAN_FOOTBALL) -> list[dict]:
        return self.get("/tournaments", sportId=sport_id)

    def nfl_tournament_id(self) -> str:
        for t in self.tournaments():
            name = (t.get("name") or t.get("tournamentName") or "").lower()
            if name == "nfl" or "national football league" in name:
                return str(t.get("tournamentId") or t.get("id"))
        raise RuntimeError("NFL tournament not found in OddsPapi sportId=14 list")

    def fixtures(self, tournament_id: str, start_from: int | None = None, start_to: int | None = None):
        return self.get(
            "/fixtures", tournamentId=tournament_id, startTimeFrom=start_from, startTimeTo=start_to
        )

    def fixture_odds(self, fixture_id: str, bookmakers: list[str] | None = None) -> dict:
        return self.get(
            "/fixtures/odds", fixtureId=fixture_id,
            bookmakers=",".join(bookmakers) if bookmakers else None,
        )

    def markets_for_outcomes(self, outcome_ids: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(outcome_ids), 100):
            for m in self.get("/markets", outcomeIds=",".join(outcome_ids[i : i + 100])):
                for o in m.get("outcomes", []) or []:
                    out[str(o.get("outcomeId"))] = {**m, "outcome": o}
        return out


def _classify(mkt: dict) -> tuple[str, str, str, str | None]:
    """→ (market, period, outcome, prop_type)"""
    mt = (mkt.get("marketType") or mkt.get("name") or "").lower()
    period = (mkt.get("period") or "full").lower()
    oname = (mkt.get("outcome", {}).get("outcomeName") or "").lower()
    if mkt.get("playerProp"):
        outcome = "over" if "over" in oname or "higher" in oname else "under" if "under" in oname or "lower" in oname else "yes" if "yes" in oname else oname
        return "player_prop", period, outcome, mt.replace(" ", "_")
    if "handicap" in mt or "spread" in mt:
        return "spread", period, "home" if oname in ("1", "home") else "away", None
    if "total" in mt or "over/under" in mt:
        return "total", period, "over" if "over" in oname else "under", None
    if mt in ("1x2", "moneyline", "money line", "winner", "match winner", "h2h"):
        return "moneyline", period, "home" if oname in ("1", "home") else "away", None
    return mt.replace(" ", "_"), period, oname, None


def snapshot_upcoming(
    conn: psycopg.Connection, api_key: str, bookmakers: list[str], days: int = 7, sport: str = "nfl"
) -> int:
    api = OddsPapi(api_key)
    with RunLogger(conn, "odds.oddspapi") as run:
        tid = api.nfl_tournament_id()
        now = datetime.now(UTC)
        fx = api.fixtures(tid, start_from=int(now.timestamp()), start_to=int(now.timestamp()) + days * 86400)
        rows: list[dict] = []
        for f in fx:
            fid = str(f.get("fixtureId") or f.get("id"))
            parts = f.get("participants") or f.get("teams") or []
            home = away = None
            for p in parts:
                abbr = team_abbr(p.get("name") or p.get("participantName"))
                if (p.get("position") or p.get("side") or "").lower().startswith("h") or p.get("isHome"):
                    home = abbr
                else:
                    away = abbr
            start = f.get("startTime")
            start_dt = datetime.fromtimestamp(start / 1000 if start and start > 1e11 else start, tz=UTC) if start else None
            gid = match_game_id(conn, home, away, start_dt, sport)

            board = api.fixture_odds(fid, bookmakers)
            odds = board.get("odds") or {}
            outcome_ids = sorted({k.split(":")[2] for bk in odds.values() for k in bk})
            mkts = api.markets_for_outcomes(outcome_ids) if outcome_ids else {}
            captured = datetime.now(UTC)
            for book, entries in odds.items():
                cb = canonical_book(book)
                if not cb:
                    continue
                for oid, o in entries.items():
                    if not o.get("active", True):
                        continue
                    _, _, outcome_id, player_id = oid.split(":")
                    mkt = mkts.get(outcome_id, {})
                    market, period, outcome, prop = _classify(mkt)
                    price = float(o["price"])
                    rows.append(
                        dict(
                            sport=sport, captured_at=captured, provider="oddspapi",
                            provider_fixture_id=fid, game_id=gid, bookmaker=cb, market=market,
                            period=period, player_id=None,  # mapped later via players table
                            prop_type=prop, outcome=outcome,
                            line=mkt.get("outcome", {}).get("handicap") or mkt.get("handicap"),
                            price_decimal=price, price_american=decimal_to_american(price),
                            is_live=False,
                            raw={"oddsId": oid, "oddspapi_player_id": player_id if player_id != "0" else None,
                                 "market": mkt.get("marketType") or mkt.get("name"), "changedAt": o.get("changedAt")},
                        )
                    )
        if rows:
            run.rows = insert_df(conn, "odds_snapshots", pl.DataFrame(rows))
        run.detail.update(fixtures=len(fx), api_calls=api.calls, books=bookmakers)
        conn.commit()
        return run.rows
