"""Environment-driven configuration. Loads .env for local dev; in Actions the
same names arrive as repository secrets."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)


def _opt(name: str) -> str | None:
    """Env var with surrounding whitespace removed — a trailing newline pasted
    into a GitHub secret is enough to make an API key 'invalid'."""
    v = os.getenv(name)
    v = v.strip() if v else None
    return v or None


def _req(name: str) -> str:
    v = _opt(name)
    if not v:
        raise RuntimeError(f"Missing required env var {name} (see .env.example)")
    return v


@dataclass(frozen=True)
class Settings:
    sport: str = "nfl"
    db_url: str = field(default_factory=lambda: _req("SUPABASE_DB_URL"))
    oddspapi_key: str | None = field(default_factory=lambda: _opt("ODDSPAPI_API_KEY"))
    oddslink_key: str | None = field(default_factory=lambda: _opt("ODDSLINK_API_KEY"))
    oddspapi_bookmakers: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            s.strip()
            for s in os.getenv("ODDSPAPI_BOOKMAKERS", "pinnacle,draftkings,betmgm,circa").split(",")
            if s.strip()
        )
    )


def settings() -> Settings:
    return Settings()
