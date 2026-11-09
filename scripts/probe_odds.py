"""One-off: confirm which bookmakers each odds provider actually exposes on
YOUR keys, before we commit the ingestion to a book list. Costs ~3 OddsPapi
requests and ~2 OddsLink requests.

    python scripts/probe_odds.py
"""

from __future__ import annotations

import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()
WANT = {"pinnacle", "circa", "draftkings", "betmgm", "fanduel", "caesars", "underdog"}


def probe_oddspapi():
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from ingest.odds_oddspapi import OddsPapi

    key = os.getenv("ODDSPAPI_API_KEY")
    if not key:
        print("ODDSPAPI_API_KEY not set; skipping")
        return
    api = OddsPapi(key)
    books = api.bookmakers()
    slugs = sorted({str(b.get("bookmakerSlug") or b.get("slug") or b.get("bookmaker") or "").lower() for b in books})
    print(f"\n== OddsPapi v4: {len(slugs)} bookmakers on your key ==")
    print("matches:", [s for s in slugs if any(w in s for w in WANT)])
    print("sample bookmaker record:", json.dumps(books[0])[:300] if books else None)
    tid = api.nfl_tournament_id()
    print("NFL tournamentId:", tid)
    from datetime import UTC, datetime, timedelta

    fx = api.fixtures(tid, datetime.now(UTC), datetime.now(UTC) + timedelta(days=7))
    print(f"upcoming NFL fixtures (7d): {len(fx)}")
    if fx:
        f = fx[0]
        print("sample:", {k: f.get(k) for k in ("fixtureId", "participant1Name", "participant1Abbr", "participant2Name", "participant2Abbr", "startTime", "hasOdds")})
    print("api calls used:", api.calls)


def probe_oddslink():
    from ingest.odds_oddslink import OddsLink

    key = os.getenv("ODDSLINK_API_KEY")
    if not key:
        print("ODDSLINK_API_KEY not set; skipping")
        return
    api = OddsLink(key)
    sports = api.sports()
    print(f"\n== OddsLink: {len(sports)} sports ==")
    print([s.get("key") for s in sports if "football" in (s.get("group") or "").lower() or s.get("key") == "nfl"])
    data = api.nfl_odds()
    events = data if isinstance(data, list) else data.get("events") or data.get("data") or []
    print(f"NFL events: {len(events)}")
    if events:
        ev = events[0]
        books = sorted({(b.get("key") or b.get("name") or "").lower() for b in ev.get("bookmakers", [])})
        print("books on first event:", books)
        print("matches:", [b for b in books if any(w in b for w in WANT)])
        print("sample event keys:", list(ev.keys()))
    print("api calls used:", api.calls)


if __name__ == "__main__":
    probe_oddspapi()
    probe_oddslink()
