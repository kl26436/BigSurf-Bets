// Sample data for running the app without a database (no .env.local). Every
// number here is invented; the app labels the whole session "Sample data".
import { SLOTS } from "./lineup";
import {
  DEFAULT_SETTINGS, type DkEntry, type FeedHealth, type Game, type Job, type LineQuote, type LineupPlayer, type LineupRow,
  type LineupSet, type PoolPlayer, type Pos, type PropEdge, type RosterPlayer, type Scorecard, type Settings, type Slate,
  type WaiverRec, type WaiverRun,
} from "./types";

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const day = (d: number, h: number) => {
  const t = new Date();
  t.setDate(t.getDate() + ((7 - t.getDay()) % 7 || 7) + d);
  t.setHours(h, d === 0 && h === 15 ? 25 : 0, 0, 0);
  return t.toISOString();
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

const MATCHUPS: [string, string, number, number, number][] = [
  ["DET", "NE", 2.5, 51.5, 12], ["ATL", "KC", -3.5, 45.5, 12], ["NYJ", "BUF", -8.5, 50.5, 12], ["NO", "CAR", 1.5, 48.5, 12],
  ["ARI", "LA", -9.5, 40.5, 15], ["DAL", "SF", -4.5, 55.5, 15],
];
const FIRST = ["Jalen", "Marcus", "Tyler", "Devon", "Chris", "Andre", "Malik", "Josh", "Darius", "Evan", "Noah", "Trey", "Isaiah", "Cole", "Micah", "Reggie"];
const LAST = ["Carter", "Hayes", "Brooks", "Nolan", "Pierce", "Sutton", "Vance", "Whitaker", "Ellis", "Monroe", "Graves", "Holt", "Barrett", "Quinn", "Maddox", "Reyes"];

export const games: Game[] = MATCHUPS.map(([home, away, spread, total, hour]) => ({
  game_id: `demo_${away}_${home}`, season: 2026, week: 10, kickoff_at: day(0, hour), home_team: home, away_team: away,
  home_score: null, away_score: null, spread_line: spread, total_line: total,
  home_implied: (total + spread) / 2, away_implied: (total - spread) / 2,
}));

export const slates: Slate[] = [{
  id: 1, slate_name: "sample", slate_type: "classic", season: 2026, week: 10, starts_at: day(0, 12), salary_cap: 50000,
  imported_at: hoursAgo(20), upcoming: true, n_players: 0, n_games: games.length,
}, {  // last week's games: nothing behind them in the sample app, so the games picker has something to pick
  id: 0, slate_name: "sample week 9", slate_type: "classic", season: 2026, week: 9, starts_at: day(-7, 12), salary_cap: 50000,
  imported_at: hoursAgo(190), upcoming: false, n_players: 0, n_games: 0,
}];

const DEPTH: [Pos, number[]][] = [["QB", [19.5, 3]], ["RB", [15.5, 9.5, 4.5]], ["WR", [16, 12, 8.5, 5]], ["TE", [10, 4.5]], ["DST", [7]]];
export const pool: PoolPlayer[] = [];
let id = 40000;
for (const g of games) {
  for (const [team, opp, implied, spread] of [
    [g.home_team, g.away_team, g.home_implied!, -g.spread_line!], [g.away_team, g.home_team, g.away_implied!, g.spread_line!]] as [string, string, number, number][]) {
    for (const [pos, means] of DEPTH) {
      means.forEach((base, k) => {
        id += 1;
        const mean = Math.max(1.5, base * (implied / 23.5) * (0.85 + rnd() * 0.3));
        const salary = pos === "DST" ? 2400 + Math.round(rnd() * 14) * 100 : Math.max(3000, Math.round((mean * 330 + rnd() * 900 + (pos === "QB" ? 400 : 0)) / 100) * 100);
        const q = k === 0 && rnd() < 0.18;
        pool.push({
          slate_id: 1, dk_id: String(id), player_id: pos === "DST" ? `DST_${team}` : `demo-${id}`,
          name: pos === "DST" ? `${team} defense` : `${FIRST[id % 16]} ${LAST[(id * 7) % 16]}`, pos, team, opponent: opp,
          game_id: g.game_id, kickoff_at: g.kickoff_at, salary, avg_points: Math.round(mean * (0.8 + rnd() * 0.4) * 10) / 10,
          dk_status: q ? "Q" : null, headshot_url: null, injury_status: q ? "Questionable" : null,
          model_dk_mean: mean, override_dk_mean: null, override_note: null, dk_mean: mean,
          dk_p10: mean * 0.32, dk_p25: mean * 0.58, dk_p50: mean * 0.93, dk_p75: mean * 1.32, dk_p90: mean * 1.8,
          ppr_mean: mean * 0.95, anytime_td_prob: pos === "QB" || pos === "DST" ? 0.08 : Math.min(0.62, mean / 34),
          implied_total: implied, team_spread: spread, total_line: g.total_line, projected_at: hoursAgo(2),
          attempts: pos === "QB" ? 33 : 0, passing_yards: pos === "QB" ? mean * 12.5 : 0, passing_tds: pos === "QB" ? mean / 11 : 0,
          carries: pos === "RB" ? mean * 1.05 : pos === "QB" ? 3.5 : 0.2, rushing_yards: pos === "RB" ? mean * 4.4 : pos === "QB" ? 15 : 1,
          targets: pos === "QB" || pos === "DST" ? 0 : mean * (pos === "RB" ? 0.28 : 0.55), receptions: pos === "QB" || pos === "DST" ? 0 : mean * (pos === "RB" ? 0.21 : 0.36),
          receiving_yards: pos === "QB" || pos === "DST" ? 0 : mean * (pos === "RB" ? 1.6 : 4.4),
        } as PoolPlayer);
      });
    }
  }
}
slates[0].n_players = pool.length;

export const whoami = { signed_in: true, member: true, role: "owner", claim_open: false };
export const health: FeedHealth[] = [
  ["nflverse.player_stats", "Game stats", 26, 100, "ok"], ["nflverse.injuries", "Injury reports", 26, 100, "ok"],
  ["sleeper.status", "Player statuses", 2.1, 40, "ok"], ["odds.oddslink", "Game lines", 91, 80, "stale"],
  ["odds.oddspapi", "Props and sharp lines", 20, 80, "ok"], ["model.project", "Projections", 2, 40, "ok"],
  ["optimizer.lineups", "Lineups", 1.9, 100, "ok"],
].map(([job, label, age, max, state], i) => ({
  job, label, sort: i, last_ok_at: hoursAgo(age as number), last_rows: 400, age_hours: age, max_age_hours: max, state, last_error: null,
})) as FeedHealth[];

function buildLineup(k: number): PoolPlayer[] {
  const by = (pos: Pos) => pool.filter((p) => p.pos === pos).sort((a, b) => (b.dk_mean! / b.salary) - (a.dk_mean! / a.salary));
  const pick = (pos: Pos, i: number) => by(pos)[(i + k * 2) % Math.min(by(pos).length, 9)];
  const qb = pick("QB", 0);
  const l = [qb, pick("RB", 0), pick("RB", 1), pick("WR", 0), pick("WR", 1), pick("WR", 2), pick("TE", 0), pick("RB", 2), pick("DST", 0)];
  return l;
}
const setPlayers = (setId: number, n: number): LineupPlayer[] =>
  Array.from({ length: n }, (_, k) => buildLineup(k + setId).map((p, i) => ({
    set_id: setId, lineup_no: k + 1, slot_no: i, slot: SLOTS[i], dk_id: p.dk_id, player_id: p.player_id, name: p.name, pos: p.pos,
    team: p.team, opponent: p.opponent, salary: p.salary, dk_mean: p.dk_mean, status: p.dk_status,
  }))).flat();

export let sets: LineupSet[] = [
  { id: 3, created_at: hoursAgo(1.9), slate_id: 1, run_id: 9, mode: "gpp", source: "auto", entered: false, label: null, job_id: null, n_lineups: 20,
    settings: { n: 20, mode: "gpp", max_exposure: 0.5, min_unique: 3, rules: { qb_stack: 1, bring_back: 0, lock: [], exclude: [] } },
    summary: { players_used: 39, max_exposure_pct: 50, avg_proj: 132.9, set_best_mean: 171, set_best_p90: 198 }, on_latest_projections: true, archived_at: null },
  { id: 2, created_at: hoursAgo(1.9), slate_id: 1, run_id: 9, mode: "cash", source: "auto", entered: false, label: null, job_id: null, n_lineups: 3,
    settings: { n: 3, mode: "cash", max_exposure: 0.67, min_unique: 3, rules: { qb_stack: 0, bring_back: 0, lock: [], exclude: [] } },
    summary: { players_used: 16, max_exposure_pct: 67, avg_proj: 135.7 }, on_latest_projections: true, archived_at: null },
  { id: 1, created_at: hoursAgo(30), slate_id: 1, run_id: 7, mode: "gpp", source: "user", entered: true, label: "Tuesday build", job_id: 1, n_lineups: 10,
    settings: { n: 10, mode: "gpp", max_exposure: 0.4, min_unique: 3, rules: { qb_stack: 1, bring_back: 1, lock: ["40001"], exclude: [] } },
    summary: { players_used: 31, max_exposure_pct: 40, avg_proj: 131.2 }, on_latest_projections: false, archived_at: null },
];
let nextSetId = 4;
/** The sample app has one scratch: a back in the entered set is ruled out after it was built. */
function scratchOne() {
  const d = detailOf(sets[2]);
  const used = d.players.filter((p) => p.pos === "RB").map((p) => p.dk_id);
  const victim = pool.find((p) => p.dk_id === used.sort((a, b) => used.filter((x) => x === b).length - used.filter((x) => x === a).length)[0]);
  if (victim) Object.assign(victim, { dk_status: "OUT", injury_status: "Out", dk_mean: null, model_dk_mean: null });
}
export const listSets = (slateId = 1) => Promise.resolve(sets.filter((s) => s.slate_id === slateId));
export const poolFor = (slateId: number) => Promise.resolve(slateId === 1 ? pool.slice() : []);
const change = (id: number, patch: Partial<LineupSet>) => { sets = sets.map((s) => (s.id === id ? { ...s, ...patch } : s)); };

type Detail = { lineups: LineupRow[]; players: LineupPlayer[] };
const details = new Map<number, Detail>();
function rows(setId: number, players: LineupPlayer[], n: number): LineupRow[] {
  return Array.from({ length: n }, (_, k) => {
    const mine = players.filter((p) => p.lineup_no === k + 1);
    const proj = mine.reduce((a, p) => a + (p.dk_mean ?? 0), 0);
    return { set_id: setId, lineup_no: k + 1, salary: mine.reduce((a, p) => a + p.salary, 0), proj, sim_mean: proj * 0.99,
      p10: proj * 0.78, p50: proj * 0.98, p90: proj * 1.24, p99: proj * (1.38 + ((k * 7) % 5) * 0.03), best_of_set_pct: Math.round((100 / n) * (0.6 + ((k * 3) % 5) * 0.2) * 10) / 10,
      actual_points: null, entered: false, edited_at: null };
  });
}
function detailOf(s: LineupSet): Detail {
  let d = details.get(s.id);
  if (!d) {
    const players = setPlayers(s.id, s.n_lineups);
    d = { lineups: rows(s.id, players, s.n_lineups).map((l) => ({ ...l, entered: s.entered })), players };
    details.set(s.id, d);
  }
  return d;
}
scratchOne();
export function setDetail(setId: number): { set: LineupSet | null; lineups: LineupRow[]; players: LineupPlayer[] } {
  const s = sets.find((x) => x.id === setId);
  return s ? { set: s, ...detailOf(s) } : { set: null, lineups: [], players: [] };
}
const touch = (setId: number, d: Detail) => { details.set(setId, { lineups: d.lineups.slice(), players: d.players.slice() }); };
export function setEntered(setId: number, entered: boolean) {
  const s = sets.find((x) => x.id === setId);
  if (s) touch(setId, { ...detailOf(s), lineups: detailOf(s).lineups.map((l) => ({ ...l, entered })) });
  change(setId, { entered });
  return Promise.resolve();
}
export function setLineupsEntered(setId: number, nos: number[], entered: boolean): Promise<number> {
  const s = sets.find((x) => x.id === setId);
  if (!s) return Promise.reject(new Error("no such lineup set"));
  const lineups = detailOf(s).lineups.map((l) => (nos.includes(l.lineup_no) ? { ...l, entered } : l));
  touch(setId, { ...detailOf(s), lineups });
  const n = lineups.filter((l) => l.entered).length;
  change(setId, { entered: n > 0 });
  return Promise.resolve(n);
}
export function manyDetail(setIds: number[]): Promise<Detail> {
  const ds = sets.filter((s) => setIds.includes(s.id)).map(detailOf);
  return Promise.resolve({ lineups: ds.flatMap((d) => d.lineups), players: ds.flatMap((d) => d.players) });
}
export function replaceLineup(setId: number, lineupNo: number, ids: string[]) {
  const s = sets.find((x) => x.id === setId);
  if (!s) return Promise.reject(new Error("no such lineup set"));
  const d = detailOf(s);
  const fresh: LineupPlayer[] = ids.map((dk, i) => {
    const p = pool.find((x) => x.dk_id === dk)!;
    return { set_id: setId, lineup_no: lineupNo, slot_no: i, slot: SLOTS[i], dk_id: p.dk_id, player_id: p.player_id, name: p.name, pos: p.pos,
      team: p.team, opponent: p.opponent, salary: p.salary, dk_mean: p.dk_mean, status: p.dk_status };
  });
  touch(setId, {
    players: [...d.players.filter((x) => x.lineup_no !== lineupNo), ...fresh],
    lineups: d.lineups.map((l) => (l.lineup_no !== lineupNo ? l : { ...l, salary: fresh.reduce((a, x) => a + x.salary, 0),
      proj: fresh.reduce((a, x) => a + (x.dk_mean ?? 0), 0), sim_mean: null, p10: null, p50: null, p90: null, p99: null, best_of_set_pct: null,
      edited_at: new Date().toISOString() })),
  });
  change(setId, {});
  return Promise.resolve();
}

// DraftKings entries: none until a file is added
let entries: DkEntry[] = [];
export const listEntries = () => Promise.resolve(entries.slice());
const sameNine = (a: string[], b: string[]) => a.slice().sort().join() === b.slice().sort().join();
export function importEntries(rows: unknown[]): Promise<{ entries: number; linked: number }> {
  const now = new Date().toISOString();
  entries = (rows as { entry_id: string; contest_id: string | null; contest_name: string | null; entry_fee: string | null; players: string[] | null }[]).map((r) => {
    const old = entries.find((e) => e.entry_id === r.entry_id);
    let link = old?.set_id != null ? { set_id: old.set_id, lineup_no: old.lineup_no } : { set_id: null as number | null, lineup_no: null as number | null };
    if (link.set_id == null && r.players) {
      for (const s of sets.filter((x) => !x.archived_at)) {
        const d = detailOf(s);
        const hit = d.lineups.find((l) => sameNine(d.players.filter((p) => p.lineup_no === l.lineup_no).map((p) => p.dk_id), r.players!));
        if (hit) { link = { set_id: s.id, lineup_no: hit.lineup_no }; void setLineupsEntered(s.id, [hit.lineup_no], true); break; }
      }
    }
    return { entry_id: r.entry_id, slate_id: 1, contest_id: r.contest_id, contest_name: r.contest_name, entry_fee: r.entry_fee == null ? null : Number(r.entry_fee),
      players: r.players, ...link, imported_at: now };
  });
  return Promise.resolve({ entries: entries.length, linked: entries.filter((e) => e.set_id != null).length });
}
export function assignEntries(list: { entry_id: string; set_id: number | null; lineup_no?: number | null }[]): Promise<number> {
  for (const a of list) {
    entries = entries.map((e) => (e.entry_id === a.entry_id ? { ...e, set_id: a.set_id, lineup_no: a.set_id == null ? null : a.lineup_no ?? null } : e));
    if (a.set_id != null && a.lineup_no != null) void setLineupsEntered(a.set_id, [a.lineup_no], true);
  }
  return Promise.resolve(list.length);
}
export function renameSet(setId: number, label: string | null) {
  change(setId, { label: label?.trim().slice(0, 60) || null });
  return Promise.resolve();
}
export function archiveSet(setId: number, archived: boolean) {
  change(setId, { archived_at: archived ? new Date().toISOString() : null });
  return Promise.resolve();
}
const ENTERED = "this set is marked as entered: archive it, or undo \"entered\" first";
export function deleteSet(setId: number) {
  if (sets.find((s) => s.id === setId)?.entered) return Promise.reject(new Error(ENTERED));
  sets = sets.filter((s) => s.id !== setId);
  details.delete(setId);
  return Promise.resolve();
}
export function deleteLineup(setId: number, lineupNo: number): Promise<number> {
  const s = sets.find((x) => x.id === setId);
  if (!s) return Promise.reject(new Error("no such lineup set"));
  if (s.entered) return Promise.reject(new Error(ENTERED));
  const d = detailOf(s);
  const lineups = d.lineups.filter((l) => l.lineup_no !== lineupNo);
  if (lineups.length === 0) return deleteSet(setId).then(() => 0);
  const players = d.players.filter((x) => x.lineup_no !== lineupNo);
  details.set(setId, { lineups, players });
  change(setId, { n_lineups: lineups.length, summary: { players_used: new Set(players.map((x) => x.dk_id)).size,
    avg_proj: lineups.reduce((a, l) => a + (l.proj ?? 0), 0) / lineups.length } });
  return Promise.resolve(lineups.length);
}
export function saveLineup(ids: string[], label?: string | null): Promise<number> {
  const id = nextSetId++;
  const players: LineupPlayer[] = ids.map((dk, i) => {
    const p = pool.find((x) => x.dk_id === dk)!;
    return { set_id: id, lineup_no: 1, slot_no: i, slot: SLOTS[i], dk_id: p.dk_id, player_id: p.player_id, name: p.name, pos: p.pos,
      team: p.team, opponent: p.opponent, salary: p.salary, dk_mean: p.dk_mean, status: p.dk_status };
  });
  const proj = players.reduce((a, x) => a + (x.dk_mean ?? 0), 0);
  details.set(id, { players, lineups: [{ set_id: id, lineup_no: 1, salary: players.reduce((a, x) => a + x.salary, 0), proj, sim_mean: null,
    p10: null, p50: null, p90: null, p99: null, best_of_set_pct: null, actual_points: null, entered: false, edited_at: null }] });
  sets = [{ id, created_at: new Date().toISOString(), slate_id: 1, run_id: 9, mode: "manual", source: "manual", entered: false,
    label: label?.trim() || null, job_id: null, n_lineups: 1, settings: {}, summary: {}, on_latest_projections: true, archived_at: null }, ...sets];
  return Promise.resolve(id);
}
/** What a finished build looks like, so the sample app shows the whole flow. */
function sampleBuild(payload: Record<string, unknown>, jobId: number): number {
  const id = nextSetId++;
  const n = Math.max(1, Math.min(150, Number(payload.n ?? 20)));
  const mode = payload.mode === "cash" ? "cash" : "gpp";
  const fresh: LineupSet = { id, created_at: new Date().toISOString(), slate_id: 1, run_id: 9, mode, source: "user", entered: false,
    label: (payload.label as string | undefined) ?? null, job_id: jobId, n_lineups: n,
    settings: { n, mode, max_exposure: payload.max_exposure, min_unique: payload.min_unique,
      rules: { qb_stack: payload.qb_stack, bring_back: payload.bring_back, lock: payload.lock ?? [], exclude: payload.exclude ?? [] } },
    summary: { players_used: Math.min(40, 9 + n), avg_proj: 131.5 }, on_latest_projections: true, archived_at: null };
  sets = [fresh, ...sets];
  return id;
}

const q = (g: Game, market: LineQuote["market"], outcome: LineQuote["outcome"], number: number, line: number | null, book: string, american: number, fair: number, best: boolean, arb: number): LineQuote => {
  const d = american > 0 ? 1 + american / 100 : 1 + 100 / -american;
  return { captured_at: hoursAgo(3), game_id: g.game_id, home_team: g.home_team, away_team: g.away_team, kickoff_at: g.kickoff_at, market, number,
    outcome, line, bookmaker: book, price_american: american, price_decimal: d, fair_prob: fair, ev: fair * d - 1, is_best: best, arb_pct: arb };
};
export const quotes: LineQuote[] = [
  q(games[0], "moneyline", "away", 0, null, "betmgm", 135, 0.445, true, 0.012), q(games[0], "moneyline", "home", 0, null, "circa", -128, 0.555, true, 0.012),
  q(games[0], "moneyline", "away", 0, null, "draftkings", 124, 0.445, false, 0.012), q(games[0], "moneyline", "home", 0, null, "pinnacle", -134, 0.555, false, 0.012),
  q(games[5], "total", "over", 55.5, 55.5, "circa", -102, 0.512, true, -0.01), q(games[5], "total", "under", 55.5, 55.5, "betmgm", -110, 0.488, true, -0.01),
  q(games[2], "spread", "home", -8.5, -8.5, "caesars", 100, 0.509, true, -0.016), q(games[2], "spread", "away", -8.5, 8.5, "fanduel", -112, 0.491, true, -0.016),
  q(games[3], "spread", "away", 1.5, -1.5, "draftkings", -105, 0.5, true, -0.03),
];
const starters = pool.filter((p) => p.pos !== "DST" && (p.dk_mean ?? 0) > 11);
export const props: PropEdge[] = starters.slice(0, 14).map((p, i) => {
  const stat = p.pos === "QB" ? "passing_yards" : p.pos === "RB" ? "rushing_yards" : i % 2 ? "receptions" : "receiving_yards";
  const mean = stat === "receptions" ? Number(p.receptions) : stat === "passing_yards" ? Number(p.passing_yards) : stat === "rushing_yards" ? Number(p.rushing_yards) : Number(p.receiving_yards);
  const fair = 0.44 + rnd() * 0.12, model = Math.min(0.7, Math.max(0.3, fair + (rnd() - 0.5) * 0.14));
  const over = 1.83 + rnd() * 0.22, under = 1.83 + rnd() * 0.22;
  return { game_id: p.game_id!, player_id: p.player_id!, player_name: p.name, team: p.team, stat, line: Math.round(mean * 0.96) + 0.5,
    bookmaker: ["betmgm", "draftkings", "circa"][i % 3], over_decimal: over, under_decimal: under, proj_mean: mean, model_over: model, fair_over: fair,
    ev_over_fair: fair * over - 1, ev_under_fair: (1 - fair) * under - 1, ev_over_model: model * over - 1, ev_under_model: (1 - model) * under - 1, captured_at: hoursAgo(3) };
});

export const scorecards: Scorecard[] = [{ season: 2026, week: 9, created_at: hoursAgo(8), metrics: {
  projections: { n_played: 212, did_not_play: 9, by_position: {
    QB: { n: 26, mae: 6.1, bias: 0.4, rank_corr: 0.47, cover_p10_p90: 0.81, vs_dk_avg: { n: 26, mae_model: 6.1, mae_dk_avg: 6.9 } },
    RB: { n: 52, mae: 5.9, bias: -0.3, rank_corr: 0.55, cover_p10_p90: 0.79 }, WR: { n: 84, mae: 5.6, bias: 0.2, rank_corr: 0.53, cover_p10_p90: 0.83 },
    TE: { n: 30, mae: 5.2, bias: 0.6, rank_corr: 0.33, cover_p10_p90: 0.77 }, DST: { n: 20, mae: 3.9, bias: -0.2, rank_corr: 0.28, cover_p10_p90: 0.8 },
    ALL: { n: 212, mae: 5.6, bias: 0.1, rank_corr: 0.58, cover_p10_p90: 0.81, vs_dk_avg: { n: 190, mae_model: 5.6, mae_dk_avg: 6.0 } } } },
  lineups: [{ set_id: 1, mode: "gpp", n: 20, n_complete: 20, avg_actual: 128.4, best_actual: 171.2, avg_projected: 131.0, in_p10_p90: 0.8 }],
  props: { n: 240, vs_pinnacle: { n: 96, logloss_model: 0.6921, logloss_pinnacle: 0.6874 }, model_edges: { n: 31, wins: 15, units: -1.4, roi: -0.045 } },
} }];

const mine = pool.filter((p, i) => p.pos !== "DST" && i % 9 === 0).slice(0, 12);
const asRoster = (p: PoolPlayer, starter: boolean): RosterPlayer => ({
  sleeper_id: p.dk_id, player_id: p.player_id, name: p.name, pos: p.pos, team: p.team, is_starter: starter, opponent: p.opponent,
  kickoff_at: p.kickoff_at, ppr_mean: p.ppr_mean, ppr_p10: (p.ppr_mean ?? 0) * 0.35, ppr_p90: (p.ppr_mean ?? 0) * 1.8, injury_status: p.injury_status });
export const roster: RosterPlayer[] = mine.map((p, i) => asRoster(p, i < 8));
export const freeAgents: RosterPlayer[] = pool.filter((p, i) => p.pos !== "DST" && i % 9 === 4).slice(0, 14).map((p) => asRoster(p, false))
  .sort((a, b) => (b.ppr_mean ?? 0) - (a.ppr_mean ?? 0));

const owners = ["You", "Rip Tide", "Shore Break", "Undertow", "Low Tide"];
export const waiverRun: WaiverRun = {
  id: 1, created_at: hoursAgo(3), week: 10, teams_left: 5, budget: 687, chop: 0.14, win: 0.21, drops: [{ name: roster[11]?.name ?? "Bench player", pos: "WR", loss: 0 }],
  teams: owners.map((owner, i) => ({ roster_id: i + 1, owner, is_me: i === 0, budget: [687, 969, 410, 330, 50][i], mean: [110, 113, 96, 119, 132][i], chop: [0.14, 0.11, 0.52, 0.07, 0.03][i], win: [0.21, 0.2, 0.04, 0.2, 0.35][i] })),
};
export const waiverRecs: WaiverRec[] = freeAgents.slice(0, 6).map((p, i) => ({
  run_id: 1, rank: i + 1, sleeper_id: p.sleeper_id, name: p.name, pos: p.pos, team: p.team, status: p.injury_status, proj: p.ppr_mean,
  level: p.ppr_mean ?? 0, gain_now: 9 - i * 1.6, gain_avg: 8 - i * 1.4, d_chop: -0.05 + i * 0.008, d_win: 0.09 - i * 0.015,
  bid_50: 240 - i * 40, bid_80: 330 - i * 55, bid_95: 480 - i * 80, bid: i === 0 ? 290 : i === 1 ? 245 : 0, win_at_bid: i < 2 ? 0.7 : null,
  either_or: i < 2 ? "A" : null, drop_name: i < 2 ? roster[11]?.name ?? "Bench player" : null,
  rivals: [{ owner: "Rip Tide", bid: 160 - i * 20 }, { owner: "Shore Break", bid: 130 - i * 20 }], can_outbid: i < 2 ? ["Rip Tide", "Shore Break"] : [],
}));

let jobList: Job[] = [{ id: 1, created_at: hoursAgo(30), kind: "build_lineups", payload: { n: 10 }, status: "done", started_at: hoursAgo(30),
  finished_at: hoursAgo(29.9), result: { set_id: 1, n_lineups: 10 }, error: null, dismissed_at: null }];
export const jobs = () => Promise.resolve(jobList);
/** Nothing is connected in the sample app. A lineup build is acted out (a few
 *  seconds, then sample lineups) so the flow can be seen; everything else says so. */
export function addJob(kind: string, payload: Record<string, unknown>) {
  const id = Math.max(0, ...jobList.map((j) => j.id)) + 1;
  const acted = kind === "build_lineups";
  const now = new Date().toISOString();
  const job: Job = { id, created_at: now, kind, payload, status: acted ? "running" : "needs_setup", started_at: acted ? now : null, finished_at: null,
    result: null, error: acted ? null : "Sample data: nothing is connected, so nothing was started.", dismissed_at: null };
  jobList = [job, ...jobList];
  if (acted) {
    setTimeout(() => {
      const setId = sampleBuild(payload, id);
      jobList = jobList.map((j) => (j.id === id ? { ...j, status: "done", finished_at: new Date().toISOString(), result: { set_id: setId, n_lineups: payload.n } } : j));
    }, 3000);
  }
  return Promise.resolve(job.id);
}
export function dismissJob(id: number) {
  jobList = jobList.map((j) => (j.id === id ? { ...j, dismissed_at: new Date().toISOString() } : j));
  return Promise.resolve();
}
export function setOverride(playerId: string, mean: number | null) {
  const p = pool.find((x) => x.player_id === playerId);
  if (p) { p.override_dk_mean = mean; p.dk_mean = mean ?? p.model_dk_mean; }
  return Promise.resolve();
}
export const log = (playerId: string) => {
  const p = pool.find((x) => x.player_id === playerId);
  return Promise.resolve(Array.from({ length: 6 }, (_, i) => ({ season: 2026, week: 9 - i, opponent: ["GB", "MIN", "CHI", "TB", "PHI", "SEA"][i],
    fantasy_points_dk: Math.round((p?.dk_mean ?? 8) * (0.5 + rnd()) * 10) / 10, targets: Math.round(4 + rnd() * 6), receptions: Math.round(2 + rnd() * 5),
    receiving_yards: Math.round(20 + rnd() * 80), carries: p?.pos === "RB" ? Math.round(8 + rnd() * 12) : 0, rushing_yards: p?.pos === "RB" ? Math.round(30 + rnd() * 70) : 0,
    passing_yards: p?.pos === "QB" ? Math.round(180 + rnd() * 130) : 0 })));
};
export const loadSettings = (): Partial<Settings> => {
  try { return JSON.parse(localStorage.getItem("bsb-demo-settings") ?? "{}"); } catch { return {}; }
};
export const saveSettings = (s: Settings) => {
  try { localStorage.setItem("bsb-demo-settings", JSON.stringify({ ...DEFAULT_SETTINGS, ...s })); } catch { /* private window */ }
  return Promise.resolve();
};
