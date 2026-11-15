from ingest.odds_oddspapi import _parse_outcome

MKTS = {
    101: {"marketId": 101, "marketName": "Full Time Result", "marketType": "1x2", "period": "fulltime",
          "playerProp": False, "handicap": 0,
          "outcomes": [{"outcomeId": 101, "outcomeName": "1"}, {"outcomeId": 103, "outcomeName": "2"}]},
    106: {"marketId": 106, "marketName": "Over Under Full Time", "marketType": "totals", "period": "fulltime",
          "playerProp": False, "handicap": 0.5,
          "outcomes": [{"outcomeId": 1012, "outcomeName": "Over"}, {"outcomeId": 1013, "outcomeName": "Under"}]},
    900: {"marketId": 900, "marketName": "Player Receiving Yards", "marketType": "totals", "period": "fulltime",
          "playerProp": True, "handicap": 0,
          "outcomes": [{"outcomeId": 9001, "outcomeName": "Over"}, {"outcomeId": 9002, "outcomeName": "Under"}]},
}


def test_moneyline():
    m = _parse_outcome(MKTS[101], 101, {"bookmakerOutcomeId": "home"}, "DAL", "PHI")
    assert m == ("moneyline", "full", "home", None, None)


def test_total_line_from_bookmaker_outcome_id():
    m = _parse_outcome(MKTS[106], 1013, {"bookmakerOutcomeId": "44.5/under"}, "DAL", "PHI")
    assert m == ("total", "full", "under", None, 44.5)


def test_player_prop():
    m = _parse_outcome(MKTS[900], 9001, {"bookmakerOutcomeId": "72.5/over", "playerName": "CeeDee Lamb"}, "DAL", "PHI")
    assert m == ("player_prop", "full", "over", "player_receiving_yards", 72.5)


def test_dataframe_with_late_strings_in_nullable_column():
    """Regression: prop_type is None for 100+ rows before the first prop appears."""
    import polars as pl

    rows = [{"a": i, "prop_type": None} for i in range(150)] + [{"a": 150, "prop_type": "pass_yards"}]
    df = pl.DataFrame(rows, infer_schema_length=None)
    assert df.schema["prop_type"] == pl.Utf8
    assert df["prop_type"].null_count() == 150


def test_get_retries_server_errors_but_not_client_errors(monkeypatch):
    import httpx
    import pytest

    from ingest import odds_oddspapi as op

    monkeypatch.setattr(op, "COOLDOWN_S", 0)
    monkeypatch.setattr(op, "RETRY_BACKOFF_S", (0, 0))
    replies = {"/tournaments": [500, 200], "/bookmakers": [401], "/markets": [500, 500, 500]}

    def handler(req: httpx.Request) -> httpx.Response:
        code = replies[req.url.path.removeprefix("/v4")].pop(0)
        return httpx.Response(code, json=[{"ok": 1}] if code == 200 else {"error": "x"})

    api = op.OddsPapi("k")
    api.h = httpx.Client(base_url=op.BASE, transport=httpx.MockTransport(handler))
    api.tally = {}
    assert api.get("/tournaments") == [{"ok": 1}]
    with pytest.raises(RuntimeError, match="401"):
        api.get("/bookmakers")                      # a bad key is not retried
    with pytest.raises(RuntimeError, match="500"):
        api.get("/markets")                         # gives up after two retries
    assert api.calls == api.tally["api_calls"] == 6
