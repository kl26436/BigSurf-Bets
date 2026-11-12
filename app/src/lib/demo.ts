// Sample data for running the app without a database (no .env.local). Every
// number here is invented; the app labels the whole session "Sample data".
import { SLOTS } from "./lineup";
import {
  DEFAULT_SETTINGS, type AppEvent, type Bet, type DkEntry, type FeedHealth, type Game, type Job, type LineQuote, type LineupPlayer, type LineupRow,
  type LineupSet, type PoolPlayer, type Pos, type PropEdge, type PushDevice, type RosterPlayer, type Scorecard, type Settings, type Slate,
  type WaiverRec, type WaiverRun, type ModelDist, type ModelRun, type Override, type PlayerResult, type PropResult,
  type Contest, type ContestEntry, type ContestPlayer, type PullStatus,
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

// ---- a single-game (captain) contest: the late game, every player twice, a kicker a side ----
export const ONE_GAME = 5;
const late = games[games.length - 1];
export const onePool: PoolPlayer[] = [];
for (const p of pool.filter((x) => x.game_id === late.game_id)) {
  const own = { ...p, slate_id: ONE_GAME, dk_id: `7${p.dk_id}` };
  onePool.push(own, { ...own, dk_id: `8${p.dk_id}-CPT`, salary: Math.round((p.salary * 1.5) / 100) * 100 });
}
[late.home_team, late.away_team].forEach((team, i) => {
  const k = { ...onePool[0], dk_id: `7900${i}`, player_id: `demo-k${i}`, name: `${FIRST[i + 3]} ${LAST[i + 9]}`, pos: "K" as Pos, team,
    opponent: i === 0 ? late.away_team : late.home_team, salary: 4000 + i * 200, dk_mean: 8.6 - i * 0.4, model_dk_mean: 8.6 - i * 0.4, dk_status: null, injury_status: null,
    dk_p10: 3, dk_p25: 5, dk_p50: 8, dk_p75: 11, dk_p90: 15, ppr_mean: null, anytime_td_prob: null, avg_points: 8.1 };
  onePool.push(k, { ...k, dk_id: `8900${i}-CPT`, salary: (4000 + i * 200) * 1.5 });
});
slates.unshift({ id: ONE_GAME, slate_name: "sample late game", slate_type: "showdown", season: 2026, week: 10, starts_at: late.kickoff_at, salary_cap: 50000,
  imported_at: hoursAgo(19), upcoming: true, n_players: onePool.length, n_games: 1 });
/** Six for the late game: a captain (his captain row) and five more, a different captain each time. */
function oneGameLineup(k: number): { p: PoolPlayer; slot: string }[] {
  const own = onePool.filter((p) => !p.dk_id.endsWith("-CPT") && p.dk_mean != null).sort((a, b) => (b.dk_mean ?? 0) - (a.dk_mean ?? 0));
  const cap = own[k % 5];
  const rest = own.filter((p) => p !== cap).filter((_, i) => (i + k) % 3 !== 2).slice(0, 4);
  const kicker = own.find((p) => p.pos === "K" && p !== cap)!;
  const capRow = onePool.find((p) => p.dk_id.endsWith("-CPT") && p.player_id === cap.player_id)!;
  return [{ p: { ...capRow, dk_mean: (cap.dk_mean ?? 0) * 1.5 }, slot: "CPT" }, ...[...rest, kicker].map((p) => ({ p, slot: "FLEX" }))];
}

export const whoami = { signed_in: true, member: true, role: "owner", claim_open: false };
export const health: FeedHealth[] = [
  ["nflverse.player_stats", "Game stats", 26, 100, "ok"], ["nflverse.injuries", "Injury reports", 26, 100, "ok"],
  ["sleeper.status", "Player statuses", 2.1, 40, "ok"], ["odds.oddslink", "Game lines", 91, 80, "stale"],
  ["odds.oddspapi", "Props and sharp lines", 20, 80, "ok"], ["model.project", "Projections", 2, 40, "ok"],
  ["optimizer.lineups", "Lineups", 1.9, 100, "ok"],
].map(([job, label, age, max, state], i) => ({
  job, label, sort: i, last_ok_at: hoursAgo(age as number), last_rows: 400, age_hours: age, max_age_hours: max, state, last_error: null,
})) as FeedHealth[];

export const pulls: PullStatus[] = [
  { job: "sleeper.league", label: "Sleeper league", checked_at: hoursAgo(0.4), changed_at: hoursAgo(5), monthly: null, used: null, reserved: null, pulls_left: null },
  { job: "odds.oddslink", label: "Game lines", checked_at: hoursAgo(91), changed_at: hoursAgo(91), monthly: null, used: null, reserved: null, pulls_left: null },
  { job: "odds.oddspapi", label: "Props and sharp lines", checked_at: hoursAgo(20), changed_at: hoursAgo(20), monthly: 250, used: 84, reserved: 70, pulls_left: 13 },
];

function buildLineup(k: number): PoolPlayer[] {
  const by = (pos: Pos) => pool.filter((p) => p.pos === pos).sort((a, b) => (b.dk_mean! / b.salary) - (a.dk_mean! / a.salary));
  const pick = (pos: Pos, i: number) => by(pos)[(i + k * 2) % Math.min(by(pos).length, 9)];
  const qb = pick("QB", 0);
  const l = [qb, pick("RB", 0), pick("RB", 1), pick("WR", 0), pick("WR", 1), pick("WR", 2), pick("TE", 0), pick("RB", 2), pick("DST", 0)];
  return l;
}
const setPlayers = (setId: number, n: number, slateId = 1): LineupPlayer[] => slateId === ONE_GAME
  ? Array.from({ length: n }, (_, k) => oneGameLineup(k + setId).map(({ p, slot }, i) => ({
    set_id: setId, lineup_no: k + 1, slot_no: i, slot, dk_id: p.dk_id, player_id: p.player_id, name: p.name, pos: p.pos,
    team: p.team, opponent: p.opponent, salary: p.salary, dk_mean: p.dk_mean, status: p.dk_status,
  }))).flat()
  : Array.from({ length: n }, (_, k) => buildLineup(k + setId).map((p, i) => ({
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
sets.push({ id: 4, created_at: hoursAgo(1.8), slate_id: ONE_GAME, run_id: 9, mode: "gpp", source: "auto", entered: false, label: null, job_id: null, n_lineups: 10,
  settings: { n: 10, mode: "gpp", max_exposure: 0.6, min_unique: 2, rules: { qb_stack: 0, bring_back: 0, lock: [], exclude: [] } },
  summary: { players_used: 14, max_exposure_pct: 60, avg_proj: 96.4 }, on_latest_projections: true, archived_at: null });
let nextSetId = 6;
/** The sample app has one scratch: a back in the entered set is ruled out after it was built. */
function scratchOne() {
  const d = detailOf(sets[2]);
  const used = d.players.filter((p) => p.pos === "RB").map((p) => p.dk_id);
  const victim = pool.find((p) => p.dk_id === used.sort((a, b) => used.filter((x) => x === b).length - used.filter((x) => x === a).length)[0]);
  if (victim) Object.assign(victim, { dk_status: "OUT", injury_status: "Out", dk_mean: null, model_dk_mean: null });
}
export const listSets = (slateId = 1) => Promise.resolve(sets.filter((s) => s.slate_id === slateId));
export const poolFor = (slateId: number) => Promise.resolve(slateId === 1 ? pool.slice() : slateId === ONE_GAME ? onePool.slice() : []);
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
    const players = setPlayers(s.id, s.n_lineups, s.slate_id);
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
  const fresh: LineupSet = { id, created_at: new Date().toISOString(), slate_id: payload.slate_id === ONE_GAME ? ONE_GAME : 1, run_id: 9, mode, source: "user", entered: false,
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
const written: LineQuote[] = [
  q(games[0], "moneyline", "away", 0, null, "betmgm", 135, 0.445, true, 0.012), q(games[0], "moneyline", "home", 0, null, "circa", -128, 0.555, true, 0.012),
  q(games[0], "moneyline", "away", 0, null, "draftkings", 124, 0.445, false, 0.012), q(games[0], "moneyline", "home", 0, null, "pinnacle", -134, 0.555, false, 0.012),
  q(games[5], "total", "over", 55.5, 55.5, "circa", -102, 0.512, true, -0.01), q(games[5], "total", "under", 55.5, 55.5, "betmgm", -110, 0.488, true, -0.01),
  q(games[2], "spread", "home", -8.5, -8.5, "caesars", 100, 0.509, true, -0.016), q(games[2], "spread", "away", -8.5, 8.5, "fanduel", -112, 0.491, true, -0.016),
  q(games[3], "spread", "away", 1.5, -1.5, "draftkings", -105, 0.5, true, -0.03), q(games[3], "spread", "home", 1.5, 1.5, "betmgm", -112, 0.5, true, -0.03),
];
/** The rest of the board: every game, three markets, six books, priced a little under the fair chance. */
function board(): LineQuote[] {
  const out: LineQuote[] = [];
  const done = new Set(written.map((x) => `${x.game_id}|${x.market}`));
  const books = ["pinnacle", "betmgm", "draftkings", "fanduel", "caesars", "circa"];
  const american = (d: number) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
  for (const g of games) {
    const spread = g.spread_line ?? 0, total = g.total_line ?? 45;
    const pHome = Math.min(0.85, Math.max(0.15, 0.5 + spread * 0.03));
    const markets: [LineQuote["market"], number, [LineQuote["outcome"], number | null, number][]][] = [
      ["spread", -spread, [["away", spread, 0.5], ["home", -spread, 0.5]]],
      ["total", total, [["over", total, 0.5], ["under", total, 0.5]]],
      ["moneyline", 0, [["away", null, 1 - pHome], ["home", null, pHome]]],
    ];
    for (const [market, number, sides] of markets) {
      if (done.has(`${g.game_id}|${market}`)) continue;
      for (const [outcome, line, fair] of sides) {
        const rows = books.map((b) => q(g, market, outcome, number, line, b, american((1 / fair) * (b === "pinnacle" ? 0.975 : 0.93 + rnd() * 0.055)), fair, false, -0.03));
        const top = Math.max(...rows.map((r) => r.price_decimal));
        rows.forEach((r) => { r.is_best = r.price_decimal === top; });
        out.push(...rows);
      }
    }
  }
  return out;
}
export const quotes: LineQuote[] = [...written, ...board()];
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

/** Sleeper's lineup with one change: the best benched runner, receiver or tight end takes the weakest such starter's place. */
function sampleLineup(): NonNullable<WaiverRun["lineup"]> {
  const flex = (p: RosterPlayer) => p.pos !== "QB";
  const up = roster.filter((p) => !p.is_starter && flex(p)).sort((a, b) => (b.ppr_mean ?? 0) - (a.ppr_mean ?? 0))[0];
  const down = roster.filter((p) => p.is_starter && flex(p)).sort((a, b) => (a.ppr_mean ?? 0) - (b.ppr_mean ?? 0))[0];
  const swap = up && down && (up.ppr_mean ?? 0) > (down.ppr_mean ?? 0);
  return roster.map((p) => {
    const start = swap && p === up ? true : swap && p === down ? false : p.is_starter;
    return { sleeper_id: p.sleeper_id, name: p.name, pos: p.pos ?? "WR", team: p.team, status: p.injury_status, mean: Math.round((p.ppr_mean ?? 0) * 10) / 10,
      start, spot: swap && p === up ? "FLEX1" : null };
  });
}

const owners = ["You", "Rip Tide", "Shore Break", "Undertow", "Low Tide"];
export const waiverRun: WaiverRun = {
  id: 1, created_at: hoursAgo(3), week: 10, teams_left: 5, budget: 687, chop: 0.14, win: 0.21, drops: [{ name: roster[11]?.name ?? "Bench player", pos: "WR", loss: 0 }],
  teams: owners.map((owner, i) => ({ roster_id: i + 1, owner, is_me: i === 0, budget: [687, 969, 410, 330, 50][i], mean: [110, 113, 96, 119, 132][i], chop: [0.14, 0.11, 0.52, 0.07, 0.03][i], win: [0.21, 0.2, 0.04, 0.2, 0.35][i] })),
  // the best legal lineup differs from the one set in Sleeper by one swap, so the start/sit note has something to say
  lineup: sampleLineup(),
  coming: owners.slice(1).map((owner, i) => ({ owner, budget: [969, 410, 330, 50][i], chop_1: [0.11, 0.52, 0.07, 0.03][i], chop_3: [0.38, 0.93, 0.3, 0.12][i],
    players: freeAgents.slice(i * 3, i * 3 + 3).map((p, k) => ({ name: p.name, pos: p.pos ?? "WR", level: Math.round((18 - k * 3 - i) * 10) / 10, gain: Math.max(0, Math.round((7.5 - k * 2.5 - i * 0.8) * 10) / 10) })) }))
    .sort((a, b) => b.chop_3 - a.chop_3),
  advice: { verdict: "either", my_chop: 0.14, later_gain: 5.9, now: { name: freeAgents[0]?.name ?? "Free agent", gain: 8, price_80: 330, d_chop: -0.05 },
    likeliest: { owner: "Shore Break", chop: 0.52, name: freeAgents[3]?.name ?? "Their best player", gain: 6.7 },
    needs: [{ spot: "RB2", name: roster[2]?.name ?? "Starter", mine: 8.4, league: 11.9, gap: -3.5 }, { spot: "TE", name: roster[5]?.name ?? "Starter", mine: 6.1, league: 8.0, gap: -1.9 },
      { spot: "WR1", name: roster[3]?.name ?? "Starter", mine: 17.2, league: 15.1, gap: 2.1 }] },
  grade: { week: 9, priced_at: hoursAgo(190), settled_at: hoursAgo(170), n: 4, beat_50: 2, beat_80: 3, beat_95: 4, rows: [
    { name: "Marcus Hayes", pos: "WR", bid_50: 210, bid_80: 300, bid_95: 430, suggested: 260, top_rival: 281, won_by: "Rip Tide", paid: 281, i_won: false, my_bid: 260 },
    { name: "Devon Pierce", pos: "RB", bid_50: 120, bid_80: 170, bid_95: 240, suggested: 0, top_rival: 96, won_by: "Undertow", paid: 96, i_won: false, my_bid: null },
    { name: "Cole Maddox", pos: "TE", bid_50: 40, bid_80: 70, bid_95: 110, suggested: 0, top_rival: 55, won_by: "Shore Break", paid: 55, i_won: false, my_bid: null },
    { name: "Trey Quinn", pos: "WR", bid_50: 60, bid_80: 95, bid_95: 150, suggested: 71, top_rival: 30, won_by: "You", paid: 71, i_won: true, my_bid: 71 }] },
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
// ---- price a line, results by player, your changes ---------------------------------
// shapes like the model's: counts spread a little wider than Poisson, yards from a
// skewed spread of outcomes around the projection
const yardsGrid = (pred: number) => Array.from({ length: 201 }, (_, i) => Math.round(pred * 2.6 * Math.pow(i / 200, 1.7) * 100) / 100);
const yardsDist = (stat: string, preds: number[]): ModelDist => ({ stat, kind: "emp", params: {
  edges: preds.map((p, i) => (i < preds.length - 1 ? (p + preds[i + 1]) / 2 : p * 3)), pred_mean: preds, quantiles: preds.map(yardsGrid) } });
const countDist = (stat: string, alpha: number): ModelDist => ({ stat, kind: "nb", params: { edges: [null], alphas: [alpha] } });
export const dists: ModelDist[] = [
  yardsDist("passing_yards", [120, 200, 240, 280]), yardsDist("rushing_yards", [5, 20, 45, 75, 100]), yardsDist("receiving_yards", [8, 25, 45, 70, 95]),
  countDist("attempts", 0.02), countDist("completions", 0.03), countDist("passing_tds", 0.08), countDist("interceptions", 0.1),
  countDist("carries", 0.07), countDist("receptions", 0.12), countDist("rushing_tds", 0.3), countDist("receiving_tds", 0.3),
];
export const playerResults: PlayerResult[] = pool.filter((p) => (p.dk_mean ?? 0) > 6).slice(0, 60).map((p, i) => {
  const proj = Math.round((p.dk_mean ?? 0) * 10) / 10, dk = Math.max(0, Math.round(proj * (0.2 + ((i * 37) % 23) / 11) * 10) / 10);
  return { season: 2026, week: 9, player_id: p.player_id ?? p.dk_id, name: p.name, pos: p.pos, team: p.team, dk, proj_dk: proj,
    proj_p10: Math.round(proj * 3.2) / 10, proj_p90: Math.round(proj * 18) / 10, miss: Math.round((dk - proj) * 10) / 10 };
}).sort((a, b) => b.miss - a.miss);
export const propResults: PropResult[] = props.slice(0, 10).map((p, i) => {
  const side = i % 3 === 0 ? "under" : "over", hit = i % 2 === 0;
  const actual = Math.round((p.line + (side === "over" === hit ? 1 : -1) * (4 + i)) * 10) / 10;
  return { season: 2026, week: 9, player_id: p.player_id, name: p.player_name, team: p.team, stat: p.stat, line: p.line, bookmaker: p.bookmaker,
    over_decimal: p.over_decimal, under_decimal: p.under_decimal, proj_mean: p.proj_mean, model_over: side === "over" ? 0.58 : 0.41,
    actual: Math.max(0, actual), came_in: actual > p.line ? "over" : "under", model_side: side } as PropResult;
});
export function listOverrides(): Promise<Override[]> {
  return Promise.resolve(pool.filter((p) => p.override_dk_mean != null).map((p) => ({ season: 2026, week: 10, player_id: p.player_id!, name: p.name, pos: p.pos, team: p.team,
    opponent: p.opponent, dk_mean: p.override_dk_mean!, model_dk_mean: p.model_dk_mean, note: null, updated_at: hoursAgo(1), this_week: true })));
}
export const modelRuns: ModelRun[] = [2, 9, 21, 33, 50].map((h, i) => ({ id: 40 - i, created_at: hoursAgo(h), model_version: "p2.2", season: 2026, week: 10,
  n_players: 318 - i * 3, n_ruled_out: 148 - i * 4, metrics: { oof_mae_dk: 5.77 }, git_sha: "d851d42" }));

export const loadSettings = (): Partial<Settings> => {
  try { return JSON.parse(localStorage.getItem("bsb-demo-settings") ?? "{}"); } catch { return {}; }
};
export const saveSettings = (s: Settings) => {
  try { localStorage.setItem("bsb-demo-settings", JSON.stringify({ ...DEFAULT_SETTINGS, ...s })); } catch { /* private window */ }
  return Promise.resolve();
};

// ---- the bet record -------------------------------------------------------------
const bet = (id: number, hours: number, bookmaker: string, description: string, price: number, stake: number, result: Bet["result"], g: Game | null,
  extra: Partial<Bet> = {}): Bet => ({
  id, created_at: hoursAgo(hours), placed_at: hoursAgo(hours), bookmaker, kind: "game", description, game_id: g?.game_id ?? null, market: null, number: null,
  outcome: null, player_id: null, price_decimal: price, stake, fair_prob: null, result, settled_at: result === "open" ? null : hoursAgo(hours - 30),
  graded_by: result === "open" ? null : "score", note: null, home_team: g?.home_team ?? null, away_team: g?.away_team ?? null, kickoff_at: g?.kickoff_at ?? null,
  returned: result === "won" ? stake * price : result === "void" ? stake : result === "lost" ? 0 : null,
  profit: result === "won" ? stake * (price - 1) : result === "void" ? 0 : result === "lost" ? -stake : null, closing_fair: null, beat_close: null, ...extra });
let bets: Bet[] = [
  bet(5, 5, "betmgm", `${games[0].away_team} to win`, 2.35, 8, "open", games[0], { market: "moneyline", number: 0, outcome: "away", fair_prob: 0.445 }),
  bet(4, 26, "draftkings", `Over ${games[1].total_line ?? 47.5} · ${games[1].away_team} at ${games[1].home_team}`, 1.95, 10, "open", games[1], { market: "total", outcome: "over", fair_prob: 0.52 }),
  bet(3, 150, "fanduel", "KC -2.5", 1.95, 10, "won", null, { closing_fair: 0.535, beat_close: 0.0433, fair_prob: 0.52 }),
  bet(2, 152, "caesars", "Under 44.5 · NYJ at BUF", 1.91, 10, "lost", null, { closing_fair: 0.51, beat_close: -0.0259, fair_prob: 0.53 }),
  bet(1, 175, "betmgm", "DET to win", 1.8, 12, "won", null, { closing_fair: 0.58, beat_close: 0.044, fair_prob: 0.57 }),
];
export const listBets = () => Promise.resolve(bets.map((b) => ({ ...b })));
export function logBet(b: Record<string, unknown>): Promise<number> {
  const id = Math.max(0, ...bets.map((x) => x.id)) + 1;
  const g = games.find((x) => x.game_id === b.game_id) ?? null;
  bets = [{ ...bet(id, 0, String(b.bookmaker).toLowerCase(), String(b.description), Number(b.price_decimal), Number(b.stake), "open", g),
    kind: (b.kind as Bet["kind"]) ?? "other", market: (b.market as string) ?? null, number: (b.number as number) ?? null,
    outcome: (b.outcome as Bet["outcome"]) ?? null, player_id: (b.player_id as string) ?? null, fair_prob: (b.fair_prob as number) ?? null, note: (b.note as string) ?? null }, ...bets];
  return Promise.resolve(id);
}
export function settleBet(id: number, result: Bet["result"]): Promise<void> {
  bets = bets.map((b) => (b.id !== id ? b : { ...b, result, settled_at: result === "open" ? null : new Date().toISOString(), graded_by: result === "open" ? null : "hand",
    returned: result === "won" ? b.stake * b.price_decimal : result === "void" ? b.stake : result === "lost" ? 0 : null,
    profit: result === "won" ? b.stake * (b.price_decimal - 1) : result === "void" ? 0 : result === "lost" ? -b.stake : null }));
  return Promise.resolve();
}
export function deleteBet(id: number): Promise<void> {
  bets = bets.filter((b) => b.id !== id);
  return Promise.resolve();
}
export const gradeBets = () => Promise.resolve(0);

// ---- what changed, and pop-ups ------------------------------------------------------
const outNow = pool.find((p) => p.dk_status === "OUT");
const tagged = pool.filter((p) => p.dk_status === "Q" && (p.dk_mean ?? 0) > 9).slice(0, 2);
const mover = pool.find((p) => p.pos === "WR" && (p.dk_mean ?? 0) > 15);
export const events: AppEvent[] = [
  ...(outNow ? [{ id: 4, created_at: hoursAgo(0.4), kind: "scratch" as const, severity: "alert" as const, title: `${outNow.name} is out`,
    body: `${outNow.name} (${outNow.team}) is in 4 entered lineups.`, url: "/lineups/swap" }] : []),
  ...tagged.map((p, i) => ({ id: 3 - i, created_at: hoursAgo(3 + i * 5), kind: "status" as const, severity: "info" as const, title: `${p.name} is questionable`,
    body: `${p.team}. He had no tag before.`, url: "/players" })),
  ...(mover ? [{ id: 1, created_at: hoursAgo(9), kind: "points" as const, severity: "info" as const,
    title: `${mover.name}: ${((mover.dk_mean ?? 0) - 3.4).toFixed(1)} → ${(mover.dk_mean ?? 0).toFixed(1)} expected`, body: `${mover.team}. Up 3.4 since the last run.`, url: "/players" }] : []),
];
let devices: PushDevice[] = [];
export const listDevices = () => Promise.resolve(devices.slice());
export function saveDevice(device: string): Promise<void> {
  devices = [{ id: "sample", device, created_at: new Date().toISOString(), last_ok_at: null, failed_at: null, failures: 0 }];
  return Promise.resolve();
}
export function deleteDevice(): Promise<number> {
  const n = devices.length;
  devices = [];
  return Promise.resolve(n);
}

// ---- contest results --------------------------------------------------------------
let contestList: Contest[] = [
  { id: 2, slate_id: 0, season: 2026, week: 9, slate_type: "classic", contest_key: "171200002", name: "NFL $5 Double Up", entry_fee: 5, n_entries: 1149,
    imported_at: hoursAgo(40), scores: { max: 214.1, p99: 196.4, p90: 172.8, p75: 158.3, p50: 141.9, min: 61.2 }, n_mine: 1, best_rank: 388, best_points: 148.6,
    won: 10, n_unsettled: 0, paid: 5, profit: 5 },
  { id: 1, slate_id: 0, season: 2026, week: 9, slate_type: "classic", contest_key: "171200001", name: "NFL $3 Play-Action", entry_fee: 3, n_entries: 47562,
    imported_at: hoursAgo(41), scores: { max: 251.3, p99: 205.7, p90: 181.2, p75: 163.9, p50: 144.5, min: 38.8 }, n_mine: 3, best_rank: 2214, best_points: 186.3,
    won: 0, n_unsettled: 3, paid: 9, profit: null },
];
let contestEntryList: ContestEntry[] = [
  { contest_id: 2, entry_id: "5200001", entry_name: "you", rank: 388, points: 148.6, lineup: "", winnings: 10, set_id: 1, lineup_no: 1 },
  { contest_id: 1, entry_id: "5100001", entry_name: "you (1/3)", rank: 2214, points: 186.3, lineup: "", winnings: null, set_id: 1, lineup_no: 2 },
  { contest_id: 1, entry_id: "5100002", entry_name: "you (2/3)", rank: 19870, points: 149.1, lineup: "", winnings: null, set_id: 1, lineup_no: 3 },
  { contest_id: 1, entry_id: "5100003", entry_name: "you (3/3)", rank: 33102, points: 128.4, lineup: "", winnings: null, set_id: null, lineup_no: null },
];
const recount = () => { contestList = contestList.map((c) => {
  const mine = contestEntryList.filter((e) => e.contest_id === c.id);
  const open = mine.filter((e) => e.winnings == null).length, won = mine.reduce((a, e) => a + (e.winnings ?? 0), 0);
  const paid = c.entry_fee == null ? null : c.entry_fee * mine.length;
  return { ...c, n_mine: mine.length, won, n_unsettled: open, paid, profit: open === 0 && paid != null ? won - paid : null };
}); };
export const listContests = () => Promise.resolve(contestList.slice());
export const listContestEntries = () => Promise.resolve(contestEntryList.slice());
export const contestPlayers = (contestId: number): Promise<ContestPlayer[]> => Promise.resolve(pool.filter((p) => (p.dk_mean ?? 0) > 9).slice(0, 14).map((p, i) => ({
  contest_id: contestId, name: p.name, roster_position: p.pos, player_id: p.player_id, pct_drafted: Math.round((38 - i * 2.4 + (i % 3)) * 10) / 10,
  fpts: Math.round((p.dk_mean ?? 0) * (0.4 + ((i * 5) % 7) / 4) * 10) / 10 })));
export function importContest(c: Record<string, unknown>): Promise<{ contest_id: number; entries: number; players: number }> {
  const mine = (c.entries as { entry_id: string; entry_name: string; rank: number | null; points: number | null; lineup: string }[]) ?? [];
  const had = contestList.find((x) => x.contest_key === c.contest_key);
  const id = had?.id ?? Math.max(0, ...contestList.map((x) => x.id)) + 1;
  const row: Contest = { id, slate_id: 0, season: 2026, week: 9, slate_type: "classic", contest_key: String(c.contest_key), name: had?.name ?? null, entry_fee: had?.entry_fee ?? null,
    n_entries: Number(c.n_entries), imported_at: new Date().toISOString(), scores: (c.scores as Contest["scores"]) ?? null, n_mine: 0, best_rank: mine[0]?.rank ?? null,
    best_points: Math.max(0, ...mine.map((e) => e.points ?? 0)) || null, won: 0, n_unsettled: 0, paid: null, profit: null };
  contestList = [row, ...contestList.filter((x) => x.id !== id)];
  contestEntryList = [...contestEntryList.filter((e) => e.contest_id !== id || mine.some((m) => m.entry_id === e.entry_id)),
    ...mine.filter((m) => !contestEntryList.some((e) => e.contest_id === id && e.entry_id === m.entry_id)).map((m) => ({ contest_id: id, ...m, winnings: null, set_id: null, lineup_no: null }))];
  recount();
  return Promise.resolve({ contest_id: id, entries: mine.length, players: ((c.ownership as unknown[]) ?? []).length });
}
export function setContestMoney(id: number, fee: number | null, name: string | null, winnings: Record<string, number | null>): Promise<void> {
  contestList = contestList.map((c) => (c.id === id ? { ...c, entry_fee: fee ?? c.entry_fee, name: name?.trim() || c.name } : c));
  contestEntryList = contestEntryList.map((e) => (e.contest_id === id && e.entry_id in winnings ? { ...e, winnings: winnings[e.entry_id] } : e));
  recount();
  return Promise.resolve();
}
export function deleteContest(id: number): Promise<void> {
  contestList = contestList.filter((c) => c.id !== id);
  contestEntryList = contestEntryList.filter((e) => e.contest_id !== id);
  return Promise.resolve();
}
