from ingest.odds_common import american_to_decimal, canonical_book, decimal_to_american, team_abbr


def test_price_roundtrip():
    assert decimal_to_american(1.9091) == -110
    assert decimal_to_american(2.5) == 150
    assert round(american_to_decimal(-110), 4) == 1.9091
    assert american_to_decimal(150) == 2.5


def test_team_abbr():
    assert team_abbr("Dallas Cowboys") == "DAL"
    assert team_abbr("49ers") == "SF"
    assert team_abbr("Los Angeles Rams") == "LA"
    assert team_abbr("nobody") is None


def test_canonical_book():
    assert canonical_book("Circa Sports") == "circa"
    assert canonical_book("DraftKings") == "draftkings"
    assert canonical_book("bet365") is None
