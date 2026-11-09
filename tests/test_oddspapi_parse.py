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
