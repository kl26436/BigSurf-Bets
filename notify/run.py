"""Detect → record → send → log."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

import psycopg

from . import detect, send
from .detect import Event

log = logging.getLogger(__name__)
# several players ruled out at once (inactives lists) go out as one message per person
MAX_SEPARATE = 2


def record(conn: psycopg.Connection, events: list[Event]) -> list[tuple[int, Event]]:
    """Store the events that are new; each change is kept once (dedupe_key)."""
    fresh = []
    for e in events:
        row = conn.execute(
            """insert into bsb.events (kind, dedupe_key, severity, title, body, url, slate_id, player_id, data)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb) on conflict (dedupe_key) do nothing returning id""",
            (e.kind, e.dedupe_key, e.severity, e.title, e.body, e.url, e.slate_id, e.player_id, json.dumps(e.data)),
        ).fetchone()
        if row:
            fresh.append((row[0], e))
    conn.commit()
    return fresh


def recipients(conn: psycopg.Connection, only_user: str | None = None) -> list[dict]:
    """Everyone with access to the app, their choices, and their devices."""
    rows = conn.execute(
        """select u.user_id::text, u.email, coalesce(s.settings, '{}'::jsonb)
           from bsb.app_users u left join bsb.user_settings s on s.user_id = u.user_id
           where %s::text is null or u.user_id::text = %s""",
        (only_user, only_user),
    ).fetchall()
    people = []
    for user_id, sign_in_email, settings in rows:
        subs = conn.execute("select endpoint, p256dh, auth, device from bsb.push_subscriptions where user_id = %s::uuid", (user_id,)).fetchall()
        address = (settings.get("notify_email") or "").strip() or (sign_in_email or "").strip()
        people.append({
            "user_id": user_id,
            "email": address if settings.get("notify_email_on") and "@" in address else None,
            "devices": [{"endpoint": a, "p256dh": b, "auth": c, "device": d} for a, b, c, d in subs],
        })
    return people


def _digest(batch: list[tuple[int, Event]]) -> tuple[str, str, str]:
    """One message for a batch: (title, body, url)."""
    if len(batch) == 1:
        e = batch[0][1]
        return e.title, e.body + (" Open the app to swap him out." if e.kind == "scratch" else ""), e.url
    names = ", ".join(e.title for _, e in batch[:6]) + ("…" if len(batch) > 6 else "")
    alert = any(e.kind == "scratch" for _, e in batch)
    return (f"{len(batch)} changes to your lineups", names + (". Open the app to swap." if alert else "."),
            "/lineups/swap" if alert else "/")


def deliver(conn: psycopg.Connection, batch: list[tuple[int, Event]], people: list[dict],
            push: Callable = send.push, email: Callable = send.email) -> dict:
    """Send one batch (one message, or several rolled into one) to everyone who asked."""
    counts = {"push_sent": 0, "push_failed": 0, "email_sent": 0, "email_failed": 0}
    if not batch:
        return counts
    title, body, url = _digest(batch)
    event_id = batch[0][0]
    private_key = None

    def note(user_id, channel, target, sent: send.Sent):
        conn.execute(
            "insert into bsb.notifications (event_id, user_id, channel, target, status, error) values (%s, %s::uuid, %s, %s, %s, %s)",
            (event_id, user_id, channel, target, "skipped" if sent.skipped else "sent" if sent.ok else "failed", sent.error),
        )

    for person in people:
        for d in person["devices"]:
            private_key = private_key or send.ensure_keys(conn)[0]
            r = push(d, {"title": title, "body": body, "url": url, "tag": batch[0][1].dedupe_key}, private_key)
            note(person["user_id"], "push", d["device"] or "a device", r)
            counts["push_sent" if r.ok else "push_failed"] += 1
            if r.gone:
                conn.execute("delete from bsb.push_subscriptions where endpoint = %s", (d["endpoint"],))
            elif r.ok:
                conn.execute("update bsb.push_subscriptions set last_ok_at = now(), failed_at = null, failures = 0 where endpoint = %s", (d["endpoint"],))
            else:
                conn.execute("update bsb.push_subscriptions set failed_at = now(), failures = failures + 1 where endpoint = %s", (d["endpoint"],))
        if person["email"]:
            r = email(person["email"], title, body, url)
            note(person["user_id"], "email", send.mask(person["email"]), r)
            counts["email_sent" if r.ok else "email_failed"] += 1
        conn.commit()
    return counts


def run(conn: psycopg.Connection, push: Callable = send.push, email: Callable = send.email) -> dict:
    """What `bsb notify run` does after each status snapshot and projections run."""
    send.ensure_keys(conn)                       # so the app can offer pop-ups before the first event
    fresh = record(conn, detect.find_events(conn))
    worth = [(i, e) for i, e in fresh if e.notify]
    people = recipients(conn) if worth else []
    batches = [[x] for x in worth] if len(worth) <= MAX_SEPARATE else [worth]
    totals = {"events": len(fresh), "to_send": len(worth), "push_sent": 0, "push_failed": 0, "email_sent": 0, "email_failed": 0}
    for b in batches:
        for k, v in deliver(conn, b, people, push, email).items():
            totals[k] += v
    return totals


def test(conn: psycopg.Connection, user_id: str, push: Callable = send.push, email: Callable = send.email) -> dict:
    """A test message to one person's devices and address ("Send a test" in Settings)."""
    send.ensure_keys(conn)
    e = Event(kind="test", dedupe_key=f"test:{user_id}:{conn.execute('select extract(epoch from now())::bigint').fetchone()[0]}",
              title="Big Surf Bets: test", body="Notifications are working. This is what a scratch alert will look like.", url="/")
    fresh = record(conn, [e])
    people = recipients(conn, user_id)
    out = deliver(conn, fresh, people, push, email)
    out["devices"] = sum(len(p["devices"]) for p in people)
    out["email_on"] = any(p["email"] for p in people)
    out["email_ready"] = send.smtp_ready()
    return out
