"""Feature frame: one row per offensive skill player per game.

Every feature is computed from games *before* the row's game (shifted rolling
windows), so the exact same code builds training rows and upcoming-week rows —
upcoming games are appended as stat-less rows and inherit their features from
history. That is the guard against leakage: there is no separate inference path
to drift out of sync.

Feature families
  player   usage + efficiency EWMAs (short/long), snap share, depth-chart rank
  team     offensive volume/pace EWMAs, Vegas implied team total and spread
  opponent defense allowed, raw and opponent-adjusted (allowed minus what that
           offense normally produces), by stat and by position group
  context  starting QB quality, usage vacated by missing teammates, own injury
           report status, age/experience/draft capital
"""

from __future__ import annotations

import polars as pl

from ingest.scoring import draftkings_nfl

from .data import NFLData

POSITIONS = ["QB", "RB", "WR", "TE"]

# box-score columns carried on every row (0-filled for snap-only appearances)
STATS = [
    "completions", "attempts", "passing_yards", "passing_tds", "interceptions", "sacks",
    "passing_air_yards", "passing_epa",
    "carries", "rushing_yards", "rushing_tds", "rushing_epa",
    "targets", "receptions", "receiving_yards", "receiving_tds", "receiving_air_yards",
    "receiving_epa", "fumbles_lost", "dk", "ppr",
]
# stats the model projects
TARGET_STATS = [
    "attempts", "completions", "passing_yards", "passing_tds", "interceptions",
    "carries", "rushing_yards", "rushing_tds",
    "targets", "receptions", "receiving_yards", "receiving_tds",
]
ROLL_SHORT, ROLL_LONG = 4, 16
PLAYER_ROLL = [
    *TARGET_STATS, "sacks", "receiving_air_yards", "passing_air_yards", "dk", "ppr",
    "target_share", "carry_share", "air_yards_share", "offense_pct",
    "passing_epa", "rushing_epa", "receiving_epa",
]
TEAM_SUM = [
    "attempts", "completions", "passing_yards", "passing_tds", "interceptions", "sacks",
    "carries", "rushing_yards", "rushing_tds", "targets", "receiving_air_yards",
]
VACATED_WINDOW = 6  # team games a missing player keeps counting as "vacated usage"


def _t() -> pl.Expr:
    """Sortable game-time index."""
    return (pl.col("season") * 100 + pl.col("week")).alias("t")


def _prior_ewm(col: str, span: int, by: str) -> pl.Expr:
    """EWMA of `col` over the group's games strictly before this row."""
    return (
        pl.col(col).shift(1).ewm_mean(span=span, ignore_nulls=True, min_samples=1)
        .forward_fill().over(by)
    )


def _ratio(num: str, den: str, floor: float = 0.5) -> pl.Expr:
    return pl.when(pl.col(den) >= floor).then(pl.col(num) / pl.col(den))


# ---------------------------------------------------------------------------
# base rows
# ---------------------------------------------------------------------------

def _team_schedule(schedules: pl.DataFrame) -> pl.DataFrame:
    """Schedule in long form: one row per team per game."""
    s = schedules.select(
        "game_id", "season", "week", "game_type",
        pl.col("gameday").cast(pl.Utf8).str.to_date("%Y-%m-%d", strict=False).alias("gameday"),
        "home_team", "away_team", "home_score", "away_score",
        pl.col("spread_line").cast(pl.Float64), pl.col("total_line").cast(pl.Float64),
        "roof", "home_qb_id", "away_qb_id",
    )
    common = ["game_id", "season", "week", "game_type", "gameday", "total_line", "roof"]
    home = s.select(
        *common, pl.col("home_team").alias("team"), pl.col("away_team").alias("opponent"),
        pl.lit(1).alias("is_home"), pl.col("home_score").alias("points_for"),
        pl.col("away_score").alias("points_against"),
        pl.col("spread_line").alias("spread_team"),      # nflverse: positive = home favoured
        pl.col("home_qb_id").alias("qb_id"),
    )
    away = s.select(
        *common, pl.col("away_team").alias("team"), pl.col("home_team").alias("opponent"),
        pl.lit(0).alias("is_home"), pl.col("away_score").alias("points_for"),
        pl.col("home_score").alias("points_against"),
        (-pl.col("spread_line")).alias("spread_team"),
        pl.col("away_qb_id").alias("qb_id"),
    )
    return pl.concat([home, away]).with_columns(
        ((pl.col("total_line") + pl.col("spread_team")) / 2).alias("implied_total"),
        pl.col("roof").is_in(["dome", "closed"]).cast(pl.Int8).alias("is_dome"),
        pl.col("points_for").is_not_null().alias("played"),
        _t(),
    )


def _player_ref(players: pl.DataFrame) -> pl.DataFrame:
    return players.filter(pl.col("gsis_id").is_not_null()).unique("gsis_id").select(
        pl.col("gsis_id").alias("player_id"),
        pl.col("display_name").alias("player_name"),
        pl.col("position_group").alias("pos_ref"),
        pl.col("birth_date").cast(pl.Utf8).str.to_date("%Y-%m-%d", strict=False),
        pl.col("rookie_season").cast(pl.Int32, strict=False),
        pl.col("draft_pick").cast(pl.Float64, strict=False),
        pl.col("height").cast(pl.Float64, strict=False).alias("height_in"),
        pl.col("weight").cast(pl.Float64, strict=False).alias("weight_lb"),
        "latest_team",
        pl.col("status").alias("roster_status"),
        "pfr_id",
    )


def _played_rows(data: NFLData, ref: pl.DataFrame) -> pl.DataFrame:
    """Every game a QB/RB/WR/TE appeared in: box-score rows unioned with snap
    counts, so a receiver who ran routes but drew no targets is a real zero
    instead of a missing row (which would bias fringe players upward)."""
    st = (
        data.stats.filter(pl.col("position_group").is_in(POSITIONS) & pl.col("player_id").is_not_null())
        .with_columns(draftkings_nfl())
        .select(
            "player_id", "season", "week", "team", pl.col("position_group").alias("pos"),
            "completions", "attempts", "passing_yards", "passing_tds",
            pl.col("passing_interceptions").alias("interceptions"),
            pl.col("sacks_suffered").alias("sacks"), "passing_air_yards", "passing_epa",
            "carries", "rushing_yards", "rushing_tds", "rushing_epa",
            "targets", "receptions", "receiving_yards", "receiving_tds", "receiving_air_yards",
            "receiving_epa",
            (
                pl.col("sack_fumbles_lost").fill_null(0) + pl.col("rushing_fumbles_lost").fill_null(0)
                + pl.col("receiving_fumbles_lost").fill_null(0)
            ).alias("fumbles_lost"),
            pl.col("fantasy_points_dk").alias("dk"),
            pl.col("fantasy_points_ppr").alias("ppr"),
        )
        .unique(["player_id", "season", "week"])
    )
    pfr = ref.filter(pl.col("pfr_id").is_not_null()).unique("pfr_id").select("pfr_id", "player_id", "pos_ref")
    sn = (
        data.snaps.filter(pl.col("offense_snaps") > 0)
        .join(pfr, left_on="pfr_player_id", right_on="pfr_id")
        .filter(pl.col("pos_ref").is_in(POSITIONS))
        .select(
            "player_id", "season", "week", pl.col("team").alias("sn_team"),
            pl.col("pos_ref").alias("sn_pos"), "offense_snaps", "offense_pct",
        )
        .unique(["player_id", "season", "week"])
    )
    df = st.join(sn, on=["player_id", "season", "week"], how="full", coalesce=True)
    return df.with_columns(
        pl.coalesce("team", "sn_team").alias("team"),
        pl.coalesce("pos", "sn_pos").alias("pos"),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in STATS],
        pl.lit(False).alias("is_future"),
    ).drop("sn_team", "sn_pos")


def _upcoming_rows(
    played: pl.DataFrame, ref: pl.DataFrame, data: NFLData, season: int, week: int, out_ids: set[str]
) -> pl.DataFrame:
    """Stat-less rows for the players expected to suit up in (season, week):
    on an active roster, appeared recently, and not ruled out."""
    teams = (
        _team_schedule(data.schedules).filter((pl.col("season") == season) & (pl.col("week") == week))["team"].to_list()
    )
    last = played.with_columns(_t()).sort("t").group_by("player_id").last()
    recent = (pl.col("season") == season) & (pl.col("week") >= week - 5)
    if week <= 4:  # early season: last year's players are the candidate pool
        recent = recent | (pl.col("season") == season - 1)
    inj = data.injuries.filter(
        (pl.col("season") == season) & (pl.col("week") == week)
        & pl.col("report_status").is_in(["Out", "Doubtful"])
    )["gsis_id"].to_list()
    out = set(out_ids) | set(inj)
    cand = (
        last.filter(recent)
        .join(ref.select("player_id", "latest_team", "roster_status"), on="player_id", how="left")
        .filter(pl.col("roster_status").is_null() | (pl.col("roster_status") == "ACT"))
        .with_columns(
            pl.when(pl.col("latest_team").is_in(teams)).then(pl.col("latest_team"))
            .when(pl.col("latest_team").is_null()).then(pl.col("team"))
            .otherwise(pl.col("latest_team")).alias("team")
        )
        .filter(pl.col("team").is_in(teams) & ~pl.col("player_id").is_in(list(out)))
    )
    return cand.select(
        "player_id", pl.lit(season, pl.Int32).alias("season"), pl.lit(week, pl.Int32).alias("week"),
        "team", "pos",
        *[pl.lit(None, pl.Float64).alias(c) for c in STATS],
        pl.lit(None, pl.Float64).alias("offense_snaps"), pl.lit(None, pl.Float64).alias("offense_pct"),
        pl.lit(True).alias("is_future"),
    )


# ---------------------------------------------------------------------------
# team / defense context
# ---------------------------------------------------------------------------

def _team_features(base: pl.DataFrame, tsched: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    """→ (team_totals, team_context). team_totals holds same-game totals (for
    shares); team_context holds pre-game offense, defense and adjusted-defense
    features keyed by (season, week, team)."""
    hist = base.filter(~pl.col("is_future"))
    totals = hist.group_by("season", "week", "team").agg(
        *[pl.col(c).sum().alias(f"tm_{c}") for c in TEAM_SUM],
        *[pl.col("dk").filter(pl.col("pos") == p).sum().alias(f"tm_dk_{p}") for p in POSITIONS],
        *[pl.col("targets").filter(pl.col("pos") == p).sum().alias(f"tm_targets_{p}") for p in ("RB", "WR", "TE")],
        *[pl.col("receiving_yards").filter(pl.col("pos") == p).sum().alias(f"tm_recyds_{p}") for p in ("RB", "WR", "TE")],
    ).with_columns(
        (pl.col("tm_attempts") + pl.col("tm_carries") + pl.col("tm_sacks")).alias("tm_plays"),
    ).with_columns(
        (pl.col("tm_attempts") / pl.col("tm_plays")).alias("tm_pass_rate"),
    )
    tm_cols = [c for c in totals.columns if c.startswith("tm_")]

    tg = (
        tsched.select("season", "week", "t", "team", "opponent", "points_for", "points_against")
        .join(totals, on=["season", "week", "team"], how="left")
        .with_columns(pl.col("points_for").cast(pl.Float64).alias("tm_points"))
        .sort("team", "t")
        .with_columns(pl.int_range(pl.len()).over("team").alias("team_idx"))
    )
    off_cols = [*tm_cols, "tm_points"]
    tg = tg.with_columns(
        *[_prior_ewm(c, ROLL_SHORT, "team").alias(c.replace("tm_", "off_") + "_s") for c in off_cols],
        *[_prior_ewm(c, 12, "team").alias(c.replace("tm_", "off_") + "_l") for c in off_cols],
    )
    # what this defense allowed in each game = the opponent offense's totals;
    # adjusted = allowed minus what that offense normally produced coming in
    opp = tg.select(
        "season", "week", pl.col("team").alias("opponent"),
        *[pl.col(c).alias(c.replace("tm_", "alw_")) for c in off_cols],
        *[pl.col(c.replace("tm_", "off_") + "_l").alias(c.replace("tm_", "oppoff_")) for c in off_cols],
    )
    tg = tg.join(opp, on=["season", "week", "opponent"], how="left").sort("team", "t")
    alw = [c.replace("tm_", "alw_") for c in off_cols]
    tg = tg.with_columns(
        *[(pl.col(a) - pl.col(a.replace("alw_", "oppoff_"))).alias(a.replace("alw_", "adj_")) for a in alw]
    ).with_columns(
        *[_prior_ewm(a, 8, "team").alias(a.replace("alw_", "def_")) for a in alw],
        *[_prior_ewm(a.replace("alw_", "adj_"), 8, "team").alias(a.replace("alw_", "defadj_")) for a in alw],
    )
    off_feats = [c for c in tg.columns if c.startswith("off_")]
    def_feats = [c for c in tg.columns if c.startswith(("def_", "defadj_"))]
    own = tg.select("season", "week", "team", "team_idx", *off_feats)
    dfn = tg.select("season", "week", pl.col("team").alias("opponent"), *def_feats)
    ctx = tsched.select("season", "week", "team", "opponent").join(own, on=["season", "week", "team"]).join(
        dfn, on=["season", "week", "opponent"]
    ).drop("opponent")
    return totals.select("season", "week", "team", *tm_cols), ctx


def _vacated(df: pl.DataFrame) -> pl.DataFrame:
    """Usage left behind by teammates who played for this team in its last
    VACATED_WINDOW games but are not in this game. → per (team, team_idx)."""
    hist = df.filter(~pl.col("is_future")).select(
        "team", "team_idx", "player_id", "pos", "post_target_share", "post_carry_share"
    )
    games = df.select("team", "team_idx").unique()
    offsets = games.join(pl.DataFrame({"k": list(range(1, VACATED_WINDOW + 1))}), how="cross").with_columns(
        (pl.col("team_idx") - pl.col("k")).alias("prev_idx")
    )
    cand = (
        offsets.join(hist, left_on=["team", "prev_idx"], right_on=["team", "team_idx"])
        .sort("k")
        .unique(["team", "team_idx", "player_id"], keep="first")
    )
    missing = cand.join(df.select("team", "team_idx", "player_id"), on=["team", "team_idx", "player_id"], how="anti")
    return missing.group_by("team", "team_idx").agg(
        pl.col("post_target_share").sum().alias("miss_target_share"),
        pl.col("post_carry_share").sum().alias("miss_carry_share"),
        *[
            pl.col("post_target_share").filter(pl.col("pos") == p).sum().alias(f"miss_target_share_{p}")
            for p in ("RB", "WR", "TE")
        ],
        pl.col("post_carry_share").filter(pl.col("pos") == "RB").sum().alias("miss_carry_share_RB"),
    )


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------

def build(data: NFLData, upcoming: tuple[int, int] | None = None, out_ids: set[str] | None = None) -> pl.DataFrame:
    """Feature frame for every played player-game, plus stat-less rows for
    `upcoming` = (season, week) when given. `out_ids` are player_ids to treat as
    inactive for the upcoming week (e.g. from Sleeper's day-of statuses)."""
    ref = _player_ref(data.players)
    tsched = _team_schedule(data.schedules)
    played = _played_rows(data, ref)
    if upcoming:
        # never let rows from the target week (or later) leak in as "history"
        cutoff = upcoming[0] * 100 + upcoming[1]
        played = played.filter(pl.col("season") * 100 + pl.col("week") < cutoff)
        fut = _upcoming_rows(played, ref, data, upcoming[0], upcoming[1], out_ids or set())
        played = pl.concat([played, fut.select(played.columns)], how="vertical_relaxed")
        tsched = tsched.filter(pl.col("played") | (pl.col("t") == cutoff))
    else:
        tsched = tsched.filter(pl.col("played"))

    base = played.join(
        tsched.select(
            "season", "week", "team", "opponent", "game_id", "game_type", "gameday", "is_home",
            "spread_team", "total_line", "implied_total", "is_dome", "qb_id", "t",
        ),
        on=["season", "week", "team"], how="inner",
    ).join(ref.drop("pfr_id", "pos_ref", "latest_team", "roster_status"), on="player_id", how="left")

    totals, ctx = _team_features(base, tsched)
    df = base.join(totals, on=["season", "week", "team"], how="left").join(ctx, on=["season", "week", "team"], how="left")
    df = df.with_columns(
        _ratio("targets", "tm_targets", 1).fill_null(0.0).alias("target_share"),
        _ratio("carries", "tm_carries", 1).fill_null(0.0).alias("carry_share"),
        _ratio("receiving_air_yards", "tm_receiving_air_yards", 1).fill_null(0.0).alias("air_yards_share"),
    ).with_columns(
        # future rows must stay null so they don't feed their own rolling windows
        *[pl.when(pl.col("is_future")).then(None).otherwise(pl.col(c)).alias(c)
          for c in ("target_share", "carry_share", "air_yards_share")]
    ).sort("player_id", "t")

    by = "player_id"
    df = df.with_columns(
        *[_prior_ewm(c, ROLL_SHORT, by).alias(f"{c}_s") for c in PLAYER_ROLL],
        *[_prior_ewm(c, ROLL_LONG, by).alias(f"{c}_l") for c in PLAYER_ROLL],
        *[pl.col(c).shift(1).over(by).alias(f"{c}_last") for c in ("targets", "carries", "attempts", "offense_pct", "dk")],
        # baselines the backtest compares against
        *[pl.col(c).shift(1).rolling_mean(4, min_samples=1).over(by).alias(f"{c}_l4") for c in [*TARGET_STATS, "dk", "ppr"]],
        *[
            (pl.col(c).fill_null(0).cum_sum().over(by, "season") - pl.col(c).fill_null(0)).truediv(
                pl.int_range(pl.len()).over(by, "season")
            ).alias(f"{c}_ytd")
            for c in [*TARGET_STATS, "dk", "ppr"]
        ],
        pl.int_range(pl.len()).over(by).alias("n_games_prior"),
        pl.int_range(pl.len()).over(by, "season").alias("n_games_season"),
        (pl.col("team") != pl.col("team").shift(1).over(by)).cast(pl.Int8).alias("team_changed"),
        (pl.col("season") != pl.col("season").shift(1).over(by)).cast(pl.Int8).alias("first_game_of_season"),
        (pl.col("week") - pl.col("week").shift(1).over(by)).alias("_wk_gap"),
        # post-game usage (includes this game) — only used to value *missing* teammates later
        pl.col("target_share").ewm_mean(span=8, ignore_nulls=True).over(by).alias("post_target_share"),
        pl.col("carry_share").ewm_mean(span=8, ignore_nulls=True).over(by).alias("post_carry_share"),
    ).with_columns(
        pl.when(pl.col("first_game_of_season") == 1).then(None).otherwise(pl.col("_wk_gap")).alias("weeks_since_last"),
        *[pl.when(pl.col(f"{c}_ytd").is_finite()).then(pl.col(f"{c}_ytd")).alias(f"{c}_ytd")
          for c in [*TARGET_STATS, "dk", "ppr"]],
        # efficiency: ratio of long EWMAs (volume-weighted, far less noisy than per-game ratios)
        _ratio("receiving_yards_l", "targets_l").alias("yds_per_target"),
        _ratio("receptions_l", "targets_l").alias("catch_rate"),
        _ratio("receiving_air_yards_l", "targets_l").alias("adot"),
        _ratio("receiving_tds_l", "targets_l").alias("td_per_target"),
        _ratio("rushing_yards_l", "carries_l").alias("yds_per_carry"),
        _ratio("rushing_tds_l", "carries_l").alias("td_per_carry"),
        _ratio("passing_yards_l", "attempts_l", 2).alias("yds_per_att"),
        _ratio("completions_l", "attempts_l", 2).alias("comp_rate"),
        _ratio("passing_tds_l", "attempts_l", 2).alias("td_per_att"),
        _ratio("interceptions_l", "attempts_l", 2).alias("int_per_att"),
        _ratio("passing_epa_l", "attempts_l", 2).alias("pass_epa_per_att"),
        _ratio("receiving_epa_l", "targets_l").alias("rec_epa_per_target"),
        _ratio("rushing_epa_l", "carries_l").alias("rush_epa_per_carry"),
        (pl.col("offense_pct_s") - pl.col("offense_pct_l")).alias("snap_trend"),
        (pl.col("target_share_s") - pl.col("target_share_l")).alias("target_share_trend"),
        (pl.col("carry_share_s") - pl.col("carry_share_l")).alias("carry_share_trend"),
        ((pl.col("gameday") - pl.col("birth_date")).dt.total_days() / 365.25).alias("age"),
        (pl.col("season") - pl.col("rookie_season")).alias("years_exp"),
        (pl.col("player_id") == pl.col("qb_id")).fill_null(False).cast(pl.Int8).alias("is_starting_qb"),
        (pl.col("game_type") != "REG").cast(pl.Int8).alias("is_postseason"),
    ).drop("_wk_gap")

    # --- who else is (not) playing -----------------------------------------
    grp = ["season", "week", "team"]
    df = df.join(_vacated(df), on=["team", "team_idx"], how="left").with_columns(
        pl.col("^miss_.*$").fill_null(0.0)
    ).with_columns(
        pl.col("target_share_l").sum().over(grp).alias("active_target_share"),
        pl.col("carry_share_l").sum().over(grp).alias("active_carry_share"),
        pl.col("offense_pct_s").rank("ordinal", descending=True).over([*grp, "pos"]).alias("pos_depth_snaps"),
        pl.col("target_share_l").rank("ordinal", descending=True).over([*grp, "pos"]).alias("pos_depth_targets"),
        pl.col("carry_share_l").rank("ordinal", descending=True).over([*grp, "pos"]).alias("pos_depth_carries"),
        pl.when(pl.col("pos") == "RB").then(pl.col("miss_target_share_RB"))
        .when(pl.col("pos") == "WR").then(pl.col("miss_target_share_WR"))
        .when(pl.col("pos") == "TE").then(pl.col("miss_target_share_TE"))
        .otherwise(0.0).alias("miss_target_share_pos"),
    ).with_columns(
        # usage × volume: the structural "share of a projected team pie" terms
        _ratio("target_share_l", "active_target_share", 0.2).alias("target_share_norm"),
        _ratio("carry_share_l", "active_carry_share", 0.2).alias("carry_share_norm"),
    ).with_columns(
        (pl.col("target_share_norm") * pl.col("off_attempts_l")).alias("exp_targets"),
        (pl.col("carry_share_norm") * pl.col("off_carries_l")).alias("exp_carries"),
        (pl.col("implied_total") - pl.col("off_points_l")).alias("implied_vs_avg"),
    )

    # --- the defense, seen from this player's position ----------------------
    def by_pos(prefix: str, stat: str, positions: tuple[str, ...]) -> pl.Expr:
        e = pl.when(pl.col("pos") == positions[0]).then(pl.col(f"{prefix}_{stat}_{positions[0]}"))
        for p in positions[1:]:
            e = e.when(pl.col("pos") == p).then(pl.col(f"{prefix}_{stat}_{p}"))
        return e

    df = df.with_columns(
        by_pos("def", "dk", tuple(POSITIONS)).alias("def_dk_pos"),
        by_pos("defadj", "dk", tuple(POSITIONS)).alias("defadj_dk_pos"),
        by_pos("def", "targets", ("RB", "WR", "TE")).alias("def_targets_pos"),
        by_pos("defadj", "targets", ("RB", "WR", "TE")).alias("defadj_targets_pos"),
        by_pos("def", "recyds", ("RB", "WR", "TE")).alias("def_recyds_pos"),
        by_pos("defadj", "recyds", ("RB", "WR", "TE")).alias("defadj_recyds_pos"),
    )

    # --- starting QB (matters most for pass catchers) -----------------------
    qb = df.filter(pl.col("pos") == "QB").select(
        "season", "week", pl.col("player_id").alias("qb_id"),
        pl.col("attempts_l").alias("qb_attempts_l"), pl.col("passing_yards_l").alias("qb_pass_yds_l"),
        pl.col("yds_per_att").alias("qb_yds_per_att"), pl.col("pass_epa_per_att").alias("qb_epa_per_att"),
        pl.col("td_per_att").alias("qb_td_per_att"), pl.col("n_games_prior").alias("qb_n_games"),
        pl.col("rushing_yards_l").alias("qb_rush_yds_l"),
    )
    df = df.join(qb, on=["season", "week", "qb_id"], how="left")

    # --- own injury report ---------------------------------------------------
    inj = (
        data.injuries.filter(pl.col("gsis_id").is_not_null())
        .unique(["season", "week", "gsis_id"], keep="last")
        .select(
            "season", "week", pl.col("gsis_id").alias("player_id"),
            (pl.col("report_status") == "Questionable").fill_null(False).cast(pl.Int8).alias("inj_questionable"),
            (pl.col("report_status") == "Doubtful").fill_null(False).cast(pl.Int8).alias("inj_doubtful"),
            pl.col("practice_status").fill_null("").str.starts_with("Did Not").cast(pl.Int8).alias("prac_dnp"),
            pl.col("practice_status").fill_null("").str.starts_with("Limited").cast(pl.Int8).alias("prac_limited"),
            pl.lit(1, pl.Int8).alias("on_injury_report"),
        )
    )
    df = df.join(inj, on=["season", "week", "player_id"], how="left").with_columns(
        pl.col("inj_questionable", "inj_doubtful", "prac_dnp", "prac_limited", "on_injury_report").fill_null(0),
        pl.col("pos").replace_strict({p: i for i, p in enumerate(POSITIONS)}, return_dtype=pl.Int8).alias("pos_code"),
        pl.col("draft_pick").fill_null(300.0),
    )
    return df.sort("t", "team", "player_id")


_NOT_FEATURES = {
    "player_id", "player_name", "season", "week", "team", "opponent", "game_id", "game_type", "gameday",
    "pos", "qb_id", "t", "is_future", "birth_date", "rookie_season", "team_idx", "offense_snaps",
    "offense_pct", "target_share", "carry_share", "air_yards_share", "post_target_share", "post_carry_share",
    *STATS,
}


def feature_columns(df: pl.DataFrame) -> list[str]:
    """Model inputs: everything pre-game. Excludes ids, same-game stats/totals
    and the naive-baseline columns (kept out so baselines stay independent)."""
    return [
        c for c in df.columns
        if c not in _NOT_FEATURES
        and not c.startswith(("tm_", "alw_", "adj_", "oppoff_"))
        and not c.endswith(("_l4", "_ytd"))
        and df.schema[c].is_numeric()
    ]
