export type Pos = "QB" | "RB" | "WR" | "TE" | "DST";

export interface PoolPlayer {
  slate_id: number;
  dk_id: string;
  player_id: string | null;
  name: string;
  pos: Pos;
  team: string;
  opponent: string | null;
  game_id: string | null;
  kickoff_at: string | null;
  salary: number;
  avg_points: number | null;
  dk_status: string | null;
  headshot_url: string | null;
  injury_status: string | null;
  model_dk_mean: number | null;
  override_dk_mean: number | null;
  override_note: string | null;
  dk_mean: number | null;
  dk_p10: number | null;
  dk_p25: number | null;
  dk_p50: number | null;
  dk_p75: number | null;
  dk_p90: number | null;
  ppr_mean: number | null;
  anytime_td_prob: number | null;
  implied_total: number | null;
  team_spread: number | null;
  total_line: number | null;
  projected_at: string | null;
  [stat: string]: unknown;
}

export interface Slate {
  id: number;
  slate_name: string | null;
  slate_type: string;
  season: number;
  week: number;
  starts_at: string | null;
  salary_cap: number;
  imported_at: string;
  upcoming: boolean;
  n_players: number;
  n_games: number;
}

export interface Game {
  game_id: string;
  season: number;
  week: number;
  kickoff_at: string | null;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  spread_line: number | null;
  total_line: number | null;
  home_implied: number | null;
  away_implied: number | null;
}

export interface FeedHealth {
  job: string;
  label: string;
  sort: number;
  last_ok_at: string | null;
  last_rows: number | null;
  age_hours: number | null;
  max_age_hours: number;
  state: "ok" | "stale" | "failing" | "never";
  last_error: string | null;
}

export interface LineupSet {
  id: number;
  created_at: string;
  slate_id: number;
  run_id: number | null;
  mode: "gpp" | "cash" | "manual";
  source: "auto" | "user" | "manual";
  entered: boolean;
  label: string | null;
  job_id: number | null;
  n_lineups: number;
  settings: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  on_latest_projections: boolean;
  archived_at: string | null;   // hidden from the Lineups screen, kept for results
}

export interface LineupRow {
  set_id: number;
  lineup_no: number;
  salary: number;
  proj: number | null;
  sim_mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  best_of_set_pct: number | null;
  actual_points: number | null;
  entered: boolean;              // this lineup was played
  edited_at: string | null;      // a player was swapped after the build
}

export interface LineupPlayer {
  set_id: number;
  lineup_no: number;
  slot_no: number;
  slot: string;
  dk_id: string;
  player_id: string | null;
  name: string;
  pos: Pos;
  team: string | null;
  opponent: string | null;
  salary: number;
  dk_mean: number | null;
  status: string | null;
}

/** One row of a DraftKings entries file: a contest entry and the lineup of ours it holds. */
export interface DkEntry {
  entry_id: string;
  slate_id: number;
  contest_id: string | null;
  contest_name: string | null;
  entry_fee: number | null;
  players: string[] | null;
  set_id: number | null;
  lineup_no: number | null;
  imported_at: string;
}

export interface LineQuote {
  captured_at: string;
  game_id: string;
  home_team: string;
  away_team: string;
  kickoff_at: string | null;
  market: "moneyline" | "spread" | "total";
  number: number;
  outcome: "home" | "away" | "over" | "under";
  line: number | null;
  bookmaker: string;
  price_american: number | null;
  price_decimal: number;
  fair_prob: number | null;
  ev: number | null;
  is_best: boolean | null;
  arb_pct: number | null;
}

export interface PropEdge {
  game_id: string;
  player_id: string;
  player_name: string | null;
  team: string | null;
  stat: string;
  line: number;
  bookmaker: string;
  over_decimal: number | null;
  under_decimal: number | null;
  proj_mean: number | null;
  model_over: number | null;
  fair_over: number | null;
  ev_over_fair: number | null;
  ev_under_fair: number | null;
  ev_over_model: number | null;
  ev_under_model: number | null;
  captured_at: string | null;
}

/** A bet that was placed, as written down in the app. */
export interface Bet {
  id: number;
  created_at: string;
  placed_at: string;
  bookmaker: string;
  kind: "game" | "player" | "other";
  description: string;
  game_id: string | null;
  market: string | null;
  number: number | null;
  outcome: "home" | "away" | "over" | "under" | null;
  player_id: string | null;
  price_decimal: number;
  stake: number;
  fair_prob: number | null;          // true chance when it was placed
  result: "open" | "won" | "lost" | "void";
  settled_at: string | null;
  graded_by: string | null;          // "score": settled from the final score
  note: string | null;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  returned: number | null;
  profit: number | null;
  closing_fair: number | null;       // the sharp book's fair chance at kickoff
  beat_close: number | null;         // price taken × closing chance − 1
}

export interface Job {
  id: number;
  created_at: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "needs_setup" | "dispatched" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  dismissed_at: string | null;
}

export interface RosterPlayer {
  sleeper_id: string;
  player_id: string | null;
  name: string;
  pos: string | null;
  team: string | null;
  is_starter: boolean;
  opponent: string | null;
  kickoff_at: string | null;
  ppr_mean: number | null;
  ppr_p10: number | null;
  ppr_p90: number | null;
  injury_status: string | null;
}

export interface Scorecard {
  season: number;
  week: number;
  created_at: string;
  metrics: {
    projections?: { n_played: number; did_not_play: number; by_position: Record<string, { n: number; mae: number; bias: number; rank_corr: number | null; cover_p10_p90: number; vs_dk_avg?: { n: number; mae_model: number; mae_dk_avg: number } }> };
    // label / source / entered arrive with scorecards graded after November 2026; a lineup built by hand has no range
    lineups?: { set_id: number; mode: string; n: number; n_complete: number; avg_actual: number; best_actual: number; avg_projected: number | null;
      in_p10_p90: number | null; label?: string | null; source?: string; entered?: boolean;
      n_entered?: number; entered_avg_actual?: number; entered_best_actual?: number }[];
    props?: { n: number; vs_pinnacle?: { n: number; logloss_model: number; logloss_pinnacle: number }; model_edges?: { n: number; wins: number; units: number; roi: number } };
  };
}

export interface Settings {
  balance_dfs: number;
  balance_bets: number;
  stake_fraction: number;   // share of the full Kelly stake, 0–1
  max_stake_pct: number;    // never more than this share of the balance on one bet
  books: string[];          // sportsbooks the user can actually bet at
  notify_email_on: boolean; // e-mail alerts as well as pop-ups
  notify_email: string;     // where to; empty = the address you sign in with
}

/** Something that changed: a player ruled out, a status, expected points. */
export interface AppEvent {
  id: number;
  created_at: string;
  kind: "scratch" | "status" | "points";
  severity: "info" | "alert";
  title: string;
  body: string | null;
  url: string | null;
}
/** A device signed up for pop-ups. `id` is the SHA-256 of its push address. */
export interface PushDevice { id: string; device: string | null; created_at: string; last_ok_at: string | null; failed_at: string | null; failures: number }
/** One alert that was sent, or wasn't. */
export interface SentNote { id: number; at: string; channel: "push" | "email"; target: string; status: "sent" | "failed" | "skipped"; error: string | null; kind: string; title: string }

export const DEFAULT_SETTINGS: Settings = {
  balance_dfs: 300,
  balance_bets: 200,
  stake_fraction: 0.25,
  max_stake_pct: 0.05,
  books: ["betmgm", "circa", "draftkings", "fanduel", "caesars"],
  notify_email_on: false,
  notify_email: "",
};

export interface WaiverTeam { roster_id: number; owner: string; is_me: boolean; budget: number; mean: number; chop: number; win: number }
export interface WaiverRun {
  id: number; created_at: string; week: number; teams_left: number; budget: number; chop: number; win: number;
  teams: WaiverTeam[]; drops: { name: string; pos: string; loss: number }[] | null;
}
export interface WaiverRec {
  run_id: number; rank: number; sleeper_id: string; name: string; pos: string | null; team: string | null; status: string | null;
  proj: number | null; level: number; gain_now: number; gain_avg: number; d_chop: number; d_win: number;
  bid_50: number; bid_80: number; bid_95: number; bid: number; win_at_bid: number | null; either_or: string | null;
  drop_name: string | null; rivals: { owner: string; bid: number }[] | null; can_outbid: string[] | null;
}
