"""Thin Postgres layer: connection, bulk upsert from polars, ingest-run logging."""

from __future__ import annotations

import json
import logging
import math
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any

import polars as pl
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def _check_url(db_url: str) -> None:
    """Supabase's direct host (db.<ref>.supabase.co) is IPv6-only on the free
    plan and unreachable from GitHub Actions runners. Fail with a useful message
    instead of 'Network is unreachable'."""
    if ".supabase.co" in db_url and "pooler.supabase.com" not in db_url:
        raise RuntimeError(
            "SUPABASE_DB_URL points at the direct connection host (db.<ref>.supabase.co), "
            "which is IPv6-only and fails from GitHub Actions. In the Supabase dashboard "
            "click Connect → choose 'Session pooler' (host aws-0-<region>.pooler.supabase.com, "
            "port 5432) and use that URI instead."
        )


@contextmanager
def connect(db_url: str) -> Iterator[psycopg.Connection]:
    _check_url(db_url)
    with psycopg.connect(db_url, autocommit=False, connect_timeout=20) as conn:
        yield conn


def migrate(db_url: str) -> list[str]:
    """Apply the supabase/migrations/*.sql files that have not been applied yet,
    in filename order, and record each in bsb.schema_migrations. → names applied.

    (Until 0006 every file was re-run on every deploy. That was survivable while
    they were all idempotent, but 0001 re-granted read access to `anon` each
    time, which would have silently undone the access lock-down.)"""
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    applied: list[str] = []
    with connect(db_url) as conn:
        conn.execute("create schema if not exists bsb")
        conn.execute(
            """create table if not exists bsb.schema_migrations (
                   filename text primary key, applied_at timestamptz not null default now())"""
        )
        conn.commit()
        done = {r[0] for r in conn.execute("select filename from bsb.schema_migrations").fetchall()}
        for f in files:
            if f.name in done:
                continue
            log.info("applying %s", f.name)
            conn.execute(f.read_text())
            conn.execute("insert into bsb.schema_migrations (filename) values (%s) on conflict do nothing", (f.name,))
            conn.commit()
            applied.append(f.name)
    return applied


def recent_ok(conn: psycopg.Connection, job: str, minutes: int) -> bool:
    """Has `job` already succeeded (and written rows) in the last `minutes`?
    Lets two schedulers overlap without doing the work — or spending the API
    quota — twice."""
    if minutes <= 0:
        return False
    row = conn.execute(
        """select 1 from bsb.ingest_runs
           where job = %s and ok and coalesce(rows_written, 0) > 0
             and finished_at > now() - make_interval(mins => %s) limit 1""",
        (job, minutes),
    ).fetchone()
    return row is not None


def _py(v: Any) -> Any:
    """Coerce polars cell values into psycopg-friendly Python types."""
    if v is None:
        return None
    if isinstance(v, dict):
        return Jsonb(v)
    if isinstance(v, list):
        # list of scalars → Postgres array; list containing dicts → jsonb
        return Jsonb(v) if any(isinstance(x, (dict, list)) for x in v) else v
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _json_safe(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def upsert_df(
    conn: psycopg.Connection,
    table: str,
    df: pl.DataFrame,
    pk: Iterable[str],
    raw_from: pl.DataFrame | None = None,
    batch: int = 2000,
) -> int:
    """Upsert a polars frame into bsb.<table>. Columns in `df` must match table
    columns. If `raw_from` is given, its rows (same length/order) are packed into
    the `raw` jsonb column."""
    if df.is_empty():
        return 0
    cols = list(df.columns)
    if raw_from is not None:
        cols.append("raw")
    pk = list(pk)
    update_cols = [c for c in cols if c not in pk]

    stmt = sql.SQL(
        "insert into bsb.{t} ({cols}) values ({ph}) on conflict ({pk}) do update set {upd}"
    ).format(
        t=sql.Identifier(table),
        cols=sql.SQL(", ").join(map(sql.Identifier, cols)),
        ph=sql.SQL(", ").join(sql.Placeholder() * len(cols)),
        pk=sql.SQL(", ").join(map(sql.Identifier, pk)),
        upd=sql.SQL(", ").join(
            sql.SQL("{c} = excluded.{c}").format(c=sql.Identifier(c)) for c in update_cols
        )
        if update_cols
        else sql.SQL("updated_at = now()") if "updated_at" in cols else sql.SQL("raw = excluded.raw"),
    )

    rows = df.rows()
    raws = raw_from.to_dicts() if raw_from is not None else None
    n = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), batch):
            chunk = rows[i : i + batch]
            if raws is not None:
                chunk = [
                    tuple(_py(v) for v in r)
                    + (Jsonb({k: _json_safe(v) for k, v in raws[i + j].items()}),)
                    for j, r in enumerate(chunk)
                ]
            else:
                chunk = [tuple(_py(v) for v in r) for r in chunk]
            cur.executemany(stmt, chunk)
            n += len(chunk)
    return n


def insert_df(conn: psycopg.Connection, table: str, df: pl.DataFrame, batch: int = 2000) -> int:
    """Plain append (for snapshot tables). `raw` column, if present, must hold dicts."""
    if df.is_empty():
        return 0
    cols = list(df.columns)
    stmt = sql.SQL("insert into bsb.{t} ({cols}) values ({ph})").format(
        t=sql.Identifier(table),
        cols=sql.SQL(", ").join(map(sql.Identifier, cols)),
        ph=sql.SQL(", ").join(sql.Placeholder() * len(cols)),
    )
    rows = [tuple(_py(v) for v in r) for r in df.rows()]
    with conn.cursor() as cur:
        for i in range(0, len(rows), batch):
            cur.executemany(stmt, rows[i : i + batch])
    return len(rows)


class RunLogger:
    """Context manager that records a row in bsb.ingest_runs."""

    def __init__(self, conn: psycopg.Connection, job: str):
        self.conn, self.job = conn, job
        self.rows = 0
        self.detail: dict[str, Any] = {}

    def __enter__(self) -> RunLogger:
        self._t0 = time.time()
        cur = self.conn.execute(
            "insert into bsb.ingest_runs (job) values (%s) returning id", (self.job,)
        )
        self.id = cur.fetchone()[0]
        self.conn.commit()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        ok = exc is None
        if not ok:
            self.conn.rollback()
            self.detail["error"] = repr(exc)
        self.detail["seconds"] = round(time.time() - self._t0, 1)
        self.conn.execute(
            "update bsb.ingest_runs set finished_at = now(), ok = %s, rows_written = %s, detail = %s where id = %s",
            (ok, self.rows, json.dumps(self.detail), self.id),
        )
        self.conn.commit()
        (log.info if ok else log.error)("%s: ok=%s rows=%s %s", self.job, ok, self.rows, self.detail)
        return False  # re-raise
