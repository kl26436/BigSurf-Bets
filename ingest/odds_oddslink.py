"""OddsLink client (free tier: 1,000 req/month, pre-match, all books; props
need the paid tier). Base: https://oddslink.app/v1  Auth: X-API-Key.

Used as the cross-check / fallback for game lines. One call to
/sports/nfl/odds returns every upcoming NFL game across all books."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx
import polars as pl
import psycopg

from .db import RunLogger, insert_df
from .odds_common import canonical_book, decimal_to_american, match_game_id, team_abbr

log = logging.getLogger(__name__)
BASE = "https://oddslink.app/v1"


class OddsLink:
    def __init__(self, api_key: str):
        self.h = httpx.Client(base_url=BASE, headers={"X-API-Key": api_key}, timeout=60)
        self.calls = 0

    def get(self, path: str, **params):
        r = self.h.get(path, params={k: v for k, v in params.items() if v is not None})
        self.calls += 1
        if r.status_code >= 400:
            raise RuntimeError(f"{r.status_code} from {r.url.path}: {r.text[:4000]}")
        return r.json()

    def sports(self):
        return self.get("/sports")

    def nfl_odds(self, **params):
        return self.get("/sports/nfl/odds", **params)


def to_decimal(price: float) -> float | None:
    """OddsLink quotes American odds (-110, +145). Anything with |price| >= 100
    is American: a decimal price of 100+ does not occur on a game line. (The
    first version only converted negatives, so every plus-money quote was stored
    as a 100-to-1 shot: +145 became decimal 145.0.)"""
    if abs(price) >= 100:
        return 1 + price / 100 if price > 0 else 1 + 100 / abs(price)
    return price if price > 1.0 else None


def _iter_prices(ev: dict):
    """Yield (book, market, outcome, line, decimal, quoted) tuples. OddsLink's exact
    schema varies by version; handle the common bookmakers→markets→outcomes nest
    and keep everything else in raw."""
    for bk in ev.get("bookmakers", []) or []:
        book = bk.get("key") or bk.get("slug") or bk.get("name")
        for m in bk.get("markets", []) or []:
            mkey = (m.get("key") or m.get("name") or "").lower()
            market = {"h2h": "moneyline", "moneyline": "moneyline", "spreads": "spread",
                      "spread": "spread", "totals": "total", "total": "total"}.get(mkey, mkey)
            for o in m.get("outcomes", []) or []:
                name = (o.get("name") or "").lower()
                if market in ("moneyline", "spread"):
                    outcome = "home" if team_abbr(o.get("name")) == team_abbr(ev.get("home_team")) else "away"
                elif market == "total":
                    outcome = "over" if "over" in name else "under"
                else:
                    outcome = name
                price = o.get("price") or o.get("decimal") or o.get("odds")
                if price is None:
                    continue
                quoted = float(price)
                price = to_decimal(quoted)
                if price is None:
                    continue
                yield book, market, outcome, o.get("point") or o.get("line") or o.get("handicap"), price, quoted


def snapshot_upcoming(conn: psycopg.Connection, api_key: str, sport: str = "nfl") -> int:
    api = OddsLink(api_key)
    with RunLogger(conn, "odds.oddslink") as run:
        data = api.nfl_odds()
        events = data if isinstance(data, list) else data.get("events") or data.get("data") or []
        captured = datetime.now(UTC)
        rows = []
        for ev in events:
            home, away = team_abbr(ev.get("home_team")), team_abbr(ev.get("away_team"))
            start = ev.get("commence_time") or ev.get("start_time") or ev.get("startTime")
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00")) if isinstance(start, str) else None
            gid = match_game_id(conn, home, away, start_dt, sport)
            for book, market, outcome, line, price, quoted in _iter_prices(ev):
                cb = canonical_book(book or "")
                if not cb:
                    continue
                rows.append(
                    dict(
                        sport=sport, captured_at=captured, provider="oddslink",
                        provider_fixture_id=str(ev.get("id")), game_id=gid, bookmaker=cb,
                        market=market, period="full", player_id=None, prop_type=None,
                        outcome=outcome, line=float(line) if line is not None else None,
                        price_decimal=price, price_american=decimal_to_american(price),
                        is_live=False, raw={"book_raw": book, "quoted": quoted},
                    )
                )
        if rows:
            run.rows = insert_df(conn, "odds_snapshots", pl.DataFrame(rows, infer_schema_length=None))
        run.detail.update(events=len(events), api_calls=api.calls)
        conn.commit()
        return run.rows
