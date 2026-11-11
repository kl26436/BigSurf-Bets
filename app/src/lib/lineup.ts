// DraftKings classic rules, shared by the hand builder and every lineup view.
import type { Job, LineupSet, PoolPlayer, Pos } from "./types";

export const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"] as const;
export type Slot = (typeof SLOTS)[number];
export type Lineup = (PoolPlayer | null)[];

export const SLOT_LABEL: Record<Slot, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "Any", DST: "DEF" };
export const POS_LABEL: Record<Pos, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", DST: "DEF", K: "K" };

// ---- single-game (captain) contests ---------------------------------------------
// DraftKings lists every player twice for these: an ordinary row, and a captain row
// with its own id and 1.5x the salary. The salary import tags the captain row's id.
export const SHOWDOWN_SLOTS = ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"] as const;
export const CAPTAIN_SUFFIX = "-CPT";
export const isCaptainRow = (p: { dk_id: string }) => p.dk_id.endsWith(CAPTAIN_SUFFIX);
export const isShowdown = (s: { slate_type: string } | null | undefined) => s?.slate_type === "showdown";
/** One row per player: the ordinary rows. (A classic pool has no captain rows and comes back as it is.) */
export const onePerPlayer = <T extends { dk_id: string }>(pool: T[]): T[] => pool.filter((p) => !isCaptainRow(p));

export function emptyLineup(): Lineup {
  return SLOTS.map(() => null);
}

export function canFill(slot: Slot, pos: Pos): boolean {
  return slot === pos || (slot === "FLEX" && (pos === "RB" || pos === "WR" || pos === "TE"));
}

/** Put a player in the first open slot he fits: his own position first, then the any-position slot. */
export function addPlayer(lineup: Lineup, p: PoolPlayer): { lineup: Lineup; error?: string } {
  if (lineup.some((x) => x?.dk_id === p.dk_id)) return { lineup, error: `${p.name} is already in this lineup` };
  const open = (s: Slot) => SLOTS.findIndex((slot, i) => slot === s && lineup[i] === null);
  let i = p.pos === "DST" ? open("DST") : open(p.pos as Slot);
  if (i < 0 && p.pos !== "QB" && p.pos !== "DST") i = open("FLEX");
  if (i < 0) return { lineup, error: `No open ${POS_LABEL[p.pos]} spot — remove a player first` };
  const next = lineup.slice();
  next[i] = p;
  return { lineup: next };
}

export function removeAt(lineup: Lineup, i: number): Lineup {
  const next = lineup.slice();
  next[i] = null;
  return next;
}

export interface Check {
  filled: number;
  salary: number;
  left: number;
  expected: number;
  perOpenSpot: number | null;
  complete: boolean;
  problems: string[];
  /** worth a second look, but the lineup can still be saved */
  warnings: string[];
}

export function check(lineup: Lineup, budget = 50_000): Check {
  const players = lineup.filter((p): p is PoolPlayer => p !== null);
  const salary = players.reduce((s, p) => s + p.salary, 0);
  const expected = players.reduce((s, p) => s + (p.dk_mean ?? 0), 0);
  const open = SLOTS.length - players.length;
  const problems: string[] = [];
  if (salary > budget) problems.push(`$${(salary - budget).toLocaleString()} over budget`);
  if (open === 0 && new Set(players.map((p) => p.game_id ?? p.team)).size < 2) {
    problems.push("Players must come from at least two games");
  }
  lineup.forEach((p, i) => {
    if (p && !canFill(SLOTS[i], p.pos)) problems.push(`${p.name} can't play ${SLOT_LABEL[SLOTS[i]]}`);
  });
  const warnings: string[] = [];
  const doubt = players.filter((p) => /^(Q|D|QUESTIONABLE|DOUBTFUL)$/i.test(p.dk_status ?? p.injury_status ?? ""));
  if (doubt.length) warnings.push(`${doubt.map((p) => p.name).join(", ")} ${doubt.length === 1 ? "is" : "are"} not certain to play. Check before kickoff.`);
  for (const d of players.filter((p) => p.pos === "DST")) {
    const facing = players.filter((p) => p.pos !== "DST" && p.team === d.opponent);
    if (facing.length) warnings.push(`${facing.map((p) => p.name).join(", ")} ${facing.length === 1 ? "plays" : "play"} against your own defense: when one scores, the other loses points.`);
  }
  return {
    warnings,
    filled: players.length,
    salary,
    left: budget - salary,
    expected,
    perOpenSpot: open > 0 ? Math.floor((budget - salary) / open) : null,
    complete: open === 0 && problems.length === 0,
    problems,
  };
}

/** DraftKings lets you swap a player until his game starts. Keeping the latest
 *  kickoff in the any-position slot leaves the most swaps open on Sunday. */
export function arrangeForLateSwap(lineup: Lineup): Lineup {
  const flexAt = SLOTS.indexOf("FLEX");
  const flex = lineup[flexAt];
  if (!flex) return lineup;
  const time = (p: PoolPlayer | null) => (p?.kickoff_at ? Date.parse(p.kickoff_at) : 0);
  let latest = flexAt;
  SLOTS.forEach((slot, i) => {
    const p = lineup[i];
    if (p && slot === flex.pos && time(p) > time(lineup[latest])) latest = i;
  });
  if (latest === flexAt) return lineup;
  const next = lineup.slice();
  [next[flexAt], next[latest]] = [next[latest], next[flexAt]];
  return next;
}

/** DraftKings bulk-upload file: one lineup per row, player ids in slot order.
 *  Six ids to a lineup is a single-game contest: captain first, under that format's header. */
export function toDkCsv(lineups: string[][]): string {
  const header = lineups.length > 0 && lineups.every((ids) => ids.length === SHOWDOWN_SLOTS.length) ? SHOWDOWN_SLOTS : SLOTS;
  return [header.join(","), ...lineups.map((ids) => ids.map((id) => (id.endsWith(CAPTAIN_SUFFIX) ? id.slice(0, -CAPTAIN_SUFFIX.length) : id)).join(","))].join("\n") + "\n";
}

/** How many lineups each player is in. In a single-game set a player's captain row and
 *  ordinary row are the same player: counted together (`captain` says how often as captain),
 *  and the row kept for display is the ordinary one. */
export function exposure<T extends { dk_id: string; lineup_no: number; player_id?: string | null; slot?: string }>(rows: T[]): Map<string, { row: T; count: number; share: number; captain: number }> {
  const total = new Set(rows.map((r) => r.lineup_no)).size || 1;
  const single = rows.some((r) => r.slot === "CPT");
  const out = new Map<string, { row: T; count: number; share: number; captain: number }>();
  for (const r of rows) {
    const key = single ? r.player_id ?? r.dk_id.replace(CAPTAIN_SUFFIX, "") : r.dk_id;
    const e = out.get(key) ?? { row: r, count: 0, share: 0, captain: 0 };
    if (r.slot === "CPT") e.captain += 1; else if (e.row.slot === "CPT") e.row = r;
    e.count += 1;
    e.share = e.count / total;
    out.set(key, e);
  }
  return out;
}

/** Expected points per $1,000 of budget — the usual way to compare prices. */
export function value(p: Pick<PoolPlayer, "dk_mean" | "salary">): number | null {
  return p.dk_mean != null && p.salary > 0 ? (p.dk_mean / p.salary) * 1000 : null;
}

// ---- lineup sets ---------------------------------------------------------------

/** What the Lineups screen shows: the newest automatic set of each kind, every
 *  set the user asked for or built, and anything entered; archived sets apart.
 *  The weekly results grade the same sets (model/scorecard.py). `all` is newest first. */
export function visibleSets(all: LineupSet[]): { auto: LineupSet[]; mine: LineupSet[]; archived: LineupSet[] } {
  const active = all.filter((s) => !s.archived_at);
  const auto = ["gpp", "cash"].map((m) => active.find((s) => s.source === "auto" && s.mode === m)).filter((s): s is LineupSet => !!s);
  const mine = active.filter((s) => s.source !== "auto" || (s.entered && !auto.includes(s)));
  return { auto, mine, archived: all.filter((s) => !!s.archived_at) };
}

interface BuildRules { qb_stack?: number; bring_back?: number; lock?: string[]; exclude?: string[]; max_per_team?: number; min_salary?: number }
interface BuildSettings { n?: number; mode?: string; max_exposure?: number; min_unique?: number; rules?: BuildRules }

/** What a build uses when the options are left alone (optimizer/portfolio.py, classic.py). */
export const DEFAULT_PER_TEAM = 5;
export const DEFAULT_MIN_SPEND: Record<string, number> = { gpp: 48_500, cash: 49_000 };

/** The settings a set was built with, in the words of the Build sheet: what tells two sets apart. */
export function describeSettings(set: Pick<LineupSet, "settings" | "n_lineups" | "source">): string[] {
  if (set.source === "manual") return [];
  const s = (set.settings ?? {}) as BuildSettings;
  const r = s.rules ?? {};
  const out: string[] = [];
  if (set.n_lineups > 1 && s.max_exposure != null) out.push(`A player in at most ${Math.round(s.max_exposure * 100)}%`);
  if (set.n_lineups > 1 && s.min_unique != null) out.push(`${s.min_unique} ${s.min_unique === 1 ? "player differs" : "players differ"}`);
  if ((r.qb_stack ?? 0) > 0) out.push(r.qb_stack === 1 ? "QB with a receiver" : `QB with ${r.qb_stack} receivers`);
  if ((r.bring_back ?? 0) > 0) out.push(r.bring_back === 1 ? "plus an opponent" : `plus ${r.bring_back} opponents`);
  if (r.max_per_team != null && r.max_per_team !== DEFAULT_PER_TEAM) out.push(`at most ${r.max_per_team} from a team`);
  if (r.min_salary != null && s.mode != null && r.min_salary !== DEFAULT_MIN_SPEND[s.mode]) out.push(`spends $${r.min_salary.toLocaleString()} or more`);
  if (r.lock?.length) out.push(`${r.lock.length} locked in`);
  if (r.exclude?.length) out.push(`${r.exclude.length} left out`);
  return out;
}

/** The request that would build this set again from today's numbers. */
export function rebuildPayload(set: LineupSet): Record<string, unknown> {
  const s = (set.settings ?? {}) as BuildSettings;
  const r = s.rules ?? {};
  const out: Record<string, unknown> = { slate_id: set.slate_id, mode: set.mode, n: s.n ?? set.n_lineups, lock: r.lock ?? [], exclude: r.exclude ?? [] };
  if (s.max_exposure != null) out.max_exposure = s.max_exposure;
  if (s.min_unique != null) out.min_unique = s.min_unique;
  if (r.qb_stack != null) out.qb_stack = r.qb_stack;
  if (r.bring_back != null) out.bring_back = r.bring_back;
  if (r.max_per_team != null) out.max_per_team = r.max_per_team;
  if (r.min_salary != null) out.min_salary = r.min_salary;
  if (set.label) out.label = set.label;
  return out;
}

// ---- the hand builder's picker ------------------------------------------------
export type PickSort = "points" | "value" | "cheapest";

/** Everyone who can fill a slot — the whole list, never a top-N: the cheap end of
 *  the pool is where a lineup gets finished. */
export function pickerChoices(pool: PoolPlayer[], slot: Slot | Slot[], taken: Set<string>,
  opts: { text?: string; sort?: PickSort; fitsOnly?: boolean; left?: number } = {}): PoolPlayer[] {
  const needle = (opts.text ?? "").trim().toLowerCase();
  const slots = Array.isArray(slot) ? slot : [slot];          // several: anyone who fits one of the open spots
  const rows = pool.filter((p) => p.dk_mean != null && slots.some((s) => canFill(s, p.pos)) && !taken.has(p.dk_id)
    && (!needle || p.name.toLowerCase().includes(needle) || p.team.toLowerCase() === needle)
    && (!opts.fitsOnly || opts.left == null || p.salary <= opts.left));
  const by: Record<PickSort, (a: PoolPlayer, b: PoolPlayer) => number> = {
    points: (a, b) => (b.dk_mean ?? 0) - (a.dk_mean ?? 0),
    value: (a, b) => (value(b) ?? 0) - (value(a) ?? 0),
    cheapest: (a, b) => a.salary - b.salary || (b.dk_mean ?? 0) - (a.dk_mean ?? 0),
  };
  return rows.sort(by[opts.sort ?? "points"]);
}

/** Identity of a nine-player lineup regardless of slot order. */
export function handKey(ids: (string | null)[]): string {
  return ids.filter(Boolean).slice().sort().join(",");
}

// ---- build requests on the Lineups screen ---------------------------------------

export interface BuildCard { job: Job; state: "working" | "ready" | "failed"; setId?: number; why?: string }
const READY_FOR = 15 * 60_000;      // a finished build is announced for this long
const OVERDUE = 20 * 60_000;        // a build that has said nothing for this long is not coming

/** The build requests worth showing: under way, just finished (with the set to
 *  open), or failed. Dismissed ones are gone; a finished one drops off by itself. */
export function buildCards(jobs: Job[], sets: LineupSet[], now = Date.now()): BuildCard[] {
  const out: BuildCard[] = [];
  for (const job of jobs) {
    if (job.kind !== "build_lineups" || job.dismissed_at) continue;
    if (job.status === "done") {
      const setId = Number((job.result as { set_id?: unknown } | null)?.set_id);
      const recent = job.finished_at != null && now - Date.parse(job.finished_at) < READY_FOR;
      if (recent && sets.some((s) => s.id === setId && !s.archived_at)) out.push({ job, state: "ready", setId });
    } else if (job.status === "failed" || job.status === "needs_setup") {
      out.push({ job, state: "failed", why: job.error ?? undefined });
    } else if (now - Date.parse(job.created_at) > OVERDUE) {
      out.push({ job, state: "failed", why: "This build never reported back. Start it again." });
    } else {
      out.push({ job, state: "working" });
    }
  }
  return out.slice(0, 3);
}
