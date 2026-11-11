"""The two ways out: a pop-up on a device that signed up, and an e-mail."""

from __future__ import annotations

import base64
import json
import os
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage

import psycopg

APP_URL = "https://bigsurfbets.web.app"


# ---- pop-ups (Web Push) ------------------------------------------------------------
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def ensure_keys(conn: psycopg.Connection) -> tuple[str, str]:
    """The key pair that signs pop-ups, made once and kept in bsb.app_config (which no
    app account can read). Returns (private key, public key) as the push standard writes them."""
    have = dict(conn.execute("select key, value from bsb.app_config where key in ('vapid_private', 'vapid_public')").fetchall())
    if "vapid_private" in have and "vapid_public" in have:
        return have["vapid_private"], have["vapid_public"]
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    private = _b64(key.private_numbers().private_value.to_bytes(32, "big"))
    public = _b64(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    conn.execute(
        "insert into bsb.app_config (key, value) values ('vapid_private', %s), ('vapid_public', %s) on conflict (key) do nothing",
        (private, public),
    )
    conn.commit()
    have = dict(conn.execute("select key, value from bsb.app_config where key in ('vapid_private', 'vapid_public')").fetchall())
    return have["vapid_private"], have["vapid_public"]      # whichever pair won, if two runs raced


@dataclass
class Sent:
    ok: bool
    error: str | None = None
    gone: bool = False        # the device no longer accepts pop-ups from us: forget it
    skipped: bool = False     # not attempted: nothing is set up to send with


def push(sub: dict, payload: dict, private_key: str) -> Sent:
    """One pop-up to one device. `sub` = {endpoint, p256dh, auth}."""
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=json.dumps(payload), vapid_private_key=private_key,
            vapid_claims={"sub": APP_URL},      # Apple refuses a malformed contact; the site's address is always valid
            ttl=6 * 3600, headers={"Urgency": "high"}, timeout=15,
        )
        return Sent(True)
    except WebPushException as e:
        code = getattr(e.response, "status_code", None)
        return Sent(False, f"push service answered {code}" if code else str(e)[:200], gone=code in (404, 410))
    except Exception as e:  # noqa: BLE001 — a device that can't be reached must not stop the others
        return Sent(False, str(e)[:200])


# ---- e-mail -------------------------------------------------------------------------
def smtp_ready() -> bool:
    return bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))


def mask(address: str) -> str:
    """k…e@gmail.com — enough to recognise in the log, not the address itself."""
    name, _, domain = address.partition("@")
    return f"{name[:1]}…{name[-1:] if len(name) > 1 else ''}@{domain}"


def email(to: str, subject: str, body: str, url: str = "/") -> Sent:
    """One plain e-mail through the account in SMTP_USER / SMTP_PASSWORD (Gmail by default)."""
    if not smtp_ready():
        return Sent(False, "no sending account yet: add the SMTP_USER and SMTP_PASSWORD secrets on GitHub (docs/notifications.md)", skipped=True)
    user = os.environ["SMTP_USER"]
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Big Surf Bets <{os.getenv('SMTP_FROM') or user}>"
    msg["To"] = to
    msg.set_content(f"{body}\n\n{APP_URL}{url}\n\nYou get these because e-mail is switched on in Big Surf Bets → More → Settings.")
    try:
        host, port = os.getenv("SMTP_HOST") or "smtp.gmail.com", int(os.getenv("SMTP_PORT") or 465)
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as s:
            s.login(user, os.environ["SMTP_PASSWORD"])
            s.send_message(msg)
        return Sent(True)
    except Exception as e:  # noqa: BLE001 — the reason goes in the log the app shows
        return Sent(False, f"{type(e).__name__}: {str(e)[:160]}")
