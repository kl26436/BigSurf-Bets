import polars as pl

from ingest.scoring import draftkings_nfl


def test_dk_scoring_rb_with_bonus():
    df = pl.DataFrame(
        {
            "passing_yards": [0], "passing_tds": [0], "passing_interceptions": [0],
            "passing_2pt_conversions": [0],
            "rushing_yards": [112], "rushing_tds": [1], "rushing_2pt_conversions": [0],
            "receptions": [4], "receiving_yards": [38], "receiving_tds": [0],
            "receiving_2pt_conversions": [0],
            "sack_fumbles_lost": [0], "rushing_fumbles_lost": [1], "receiving_fumbles_lost": [0],
            "special_teams_tds": [0], "fumble_recovery_tds": [0],
        }
    )
    pts = df.select(draftkings_nfl()).item()
    # rush 11.2 + td 6 + 100yd bonus 3 + rec 4 + recyd 3.8 - fumble 1 = 27.0
    assert pts == 27.0


def test_dk_scoring_qb_300_bonus():
    df = pl.DataFrame(
        {
            "passing_yards": [325], "passing_tds": [3], "passing_interceptions": [1],
            "passing_2pt_conversions": [0],
            "rushing_yards": [12], "rushing_tds": [0], "rushing_2pt_conversions": [0],
            "receptions": [0], "receiving_yards": [0], "receiving_tds": [0],
            "receiving_2pt_conversions": [0],
            "sack_fumbles_lost": [0], "rushing_fumbles_lost": [0], "receiving_fumbles_lost": [0],
            "special_teams_tds": [0], "fumble_recovery_tds": [0],
        }
    )
    pts = df.select(draftkings_nfl()).item()
    # 13 + 12 - 1 + 3 bonus + 1.2 rush = 28.2
    assert pts == 28.2
