import pytest

from ingest import nflverse


def test_retry_succeeds_after_failures(monkeypatch):
    monkeypatch.setattr(nflverse.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("504 Gateway Time-out")
        return "ok"

    assert nflverse._retry(flaky, "flaky") == "ok"
    assert calls["n"] == 3


def test_retry_gives_up(monkeypatch):
    monkeypatch.setattr(nflverse.time, "sleep", lambda s: None)

    def always():
        raise ConnectionError("down")

    with pytest.raises(ConnectionError):
        nflverse._retry(always, "always", attempts=3)


def test_proxy_wraps_load_functions(monkeypatch):
    monkeypatch.setattr(nflverse.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def fake_load_teams():
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("transient")
        return "teams"

    monkeypatch.setattr(nflverse._nflreadpy, "load_teams", fake_load_teams)
    assert nflverse.nfl.load_teams() == "teams"
    assert calls["n"] == 2
