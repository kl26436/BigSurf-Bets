"""DFS scoring rules as polars expressions. Keep each site's rules here so the
model trains on the number we actually get paid on."""

from __future__ import annotations

import polars as pl


def _c(name: str) -> pl.Expr:
    return pl.col(name).fill_null(0)


def draftkings_nfl() -> pl.Expr:
    """DraftKings NFL Classic/Showdown scoring (offense + returns).
    https://www.draftkings.com/help/rules/nfl"""
    passing = (
        _c("passing_yards") * 0.04
        + _c("passing_tds") * 4
        - _c("passing_interceptions") * 1
        + (_c("passing_yards") >= 300).cast(pl.Int8) * 3
        + _c("passing_2pt_conversions") * 2
    )
    rushing = (
        _c("rushing_yards") * 0.1
        + _c("rushing_tds") * 6
        + (_c("rushing_yards") >= 100).cast(pl.Int8) * 3
        + _c("rushing_2pt_conversions") * 2
    )
    receiving = (
        _c("receptions") * 1
        + _c("receiving_yards") * 0.1
        + _c("receiving_tds") * 6
        + (_c("receiving_yards") >= 100).cast(pl.Int8) * 3
        + _c("receiving_2pt_conversions") * 2
    )
    misc = (
        -(_c("sack_fumbles_lost") + _c("rushing_fumbles_lost") + _c("receiving_fumbles_lost")) * 1
        + _c("special_teams_tds") * 6
        + _c("fumble_recovery_tds") * 6
    )
    return (passing + rushing + receiving + misc).round(2).alias("fantasy_points_dk")
