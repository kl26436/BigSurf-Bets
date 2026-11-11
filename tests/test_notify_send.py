"""The senders, without a database: the pop-up is really encrypted for the device, and e-mail explains itself."""

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from notify import send


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def test_a_pop_up_is_signed_and_encrypted_for_the_device(monkeypatch):
    """A stand-in push service receives what send.push posts; the device's own key opens it."""
    import http_ece
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    for var in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    got = {}

    class Service(BaseHTTPRequestHandler):
        def do_POST(self):
            got["headers"] = {k.lower(): v for k, v in self.headers.items()}
            got["body"] = self.rfile.read(int(self.headers["content-length"]))
            self.send_response(got.get("answer", 201))
            self.end_headers()

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Service)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        # the app server's signing pair, in the form ensure_keys stores it
        signer = ec.generate_private_key(ec.SECP256R1())
        private = _b64(signer.private_numbers().private_value.to_bytes(32, "big"))
        public = signer.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        # the device's pair and secret, as a browser hands them over
        device = ec.generate_private_key(ec.SECP256R1())
        auth = b"0123456789abcdef"
        sub = {"endpoint": f"http://127.0.0.1:{server.server_port}/send/xyz", "auth": _b64(auth),
               "p256dh": _b64(device.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))}
        payload = {"title": "Pat Example is out", "body": "He is in 2 entered lineups.", "url": "/lineups/swap", "tag": "scratch:1:40001:out"}

        assert send.push(sub, payload, private).ok is True
        h = got["headers"]
        assert h["content-encoding"] == "aes128gcm" and h["urgency"] == "high" and int(h["ttl"]) == 6 * 3600
        scheme, _, rest = h["authorization"].partition(" ")
        fields = dict(x.strip().split("=", 1) for x in rest.split(","))
        assert scheme == "vapid" and _unb64(fields["k"]) == public                       # signed with the pair the app subscribed with
        claims = json.loads(_unb64(fields["t"].split(".")[1]))
        assert claims["sub"] == "https://bigsurfbets.web.app" and claims["aud"] == f"http://127.0.0.1:{server.server_port}"
        opened = http_ece.decrypt(got["body"], private_key=device, auth_secret=auth, version="aes128gcm")
        assert json.loads(opened) == payload                                              # only the device can read it

        got["answer"] = 410                                                               # the device unsubscribed
        r = send.push(sub, payload, private)
        assert (r.ok, r.gone, r.error) == (False, True, "push service answered 410")
        got["answer"] = 500
        r = send.push(sub, payload, private)
        assert (r.ok, r.gone) == (False, False)
    finally:
        server.shutdown()


def test_email_without_a_sending_account_says_what_is_missing(monkeypatch):
    monkeypatch.delenv("SMTP_USER", raising=False)
    monkeypatch.delenv("SMTP_PASSWORD", raising=False)
    r = send.email("someone@example.com", "x", "y")
    assert r.ok is False and r.skipped is True and "SMTP_USER" in r.error and "docs/notifications.md" in r.error


def test_email_goes_out_through_the_configured_account(monkeypatch):
    sent = {}

    class Fake:
        def __init__(self, host, port, context=None, timeout=None):
            sent["server"] = (host, port)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def login(self, user, password):
            sent["login"] = (user, password)

        def send_message(self, msg):
            sent["msg"] = msg

    monkeypatch.setenv("SMTP_USER", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password")
    monkeypatch.delenv("SMTP_HOST", raising=False)
    monkeypatch.setenv("SMTP_PORT", "")
    monkeypatch.setattr(send.smtplib, "SMTP_SSL", Fake)
    assert send.email("me@example.com", "Pat Example is out", "He is in 2 entered lineups.", "/lineups/swap").ok is True
    assert sent["server"] == ("smtp.gmail.com", 465) and sent["login"] == ("sender@example.com", "app-password")
    m = sent["msg"]
    assert m["To"] == "me@example.com" and m["Subject"] == "Pat Example is out" and "sender@example.com" in m["From"]
    body = m.get_content()
    assert "He is in 2 entered lineups." in body and "https://bigsurfbets.web.app/lineups/swap" in body


@pytest.mark.parametrize(("address", "shown"), [("kevin@example.com", "k…n@example.com"), ("a@b.co", "a…@b.co")])
def test_an_address_is_masked_in_the_log(address, shown):
    assert send.mask(address) == shown
