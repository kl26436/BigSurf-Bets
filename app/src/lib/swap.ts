// Late swaps and the DraftKings entries file.
//
// A swap replaces a player who is ruled out with the best legal player whose game
// has not started, and leaves the other eight where they are: DraftKings locks a
// player at his own kickoff, so nothing else in the lineup may move.
import { SLOTS, canFill, type Slot } from "./lineup";
import type { DkEntry, LineupPlayer, PoolPlayer } from "./types";

const OUT = new Set(["O", "OUT", "IR", "D", "DOUBTFUL", "INJURED RESERVE"]);

/** Ruled out: gone from the pool, tagged out, or left without expected points by the pipeline. */
export function isOut(p: PoolPlayer | undefined): boolean {
  if (!p || p.dk_mean == null) return true;
  return OUT.has((p.dk_status ?? "").toUpperCase());
}
export const started = (kickoff: string | null | undefined, now: number) => !!kickoff && Date.parse(kickoff) <= now;

export interface SwapSlot {
  slotNo: number;
  slot: Slot;
  out: LineupPlayer;
  /** the pick (null: nobody legal fits the money left) */
  pick: PoolPlayer | null;
  /** affordable alternatives for this slot, best first, given the other picks */
  options: PoolPlayer[];
}
export interface SwapPlan {
  setId: number;
  lineupNo: number;
  swaps: SwapSlot[];
  /** ruled out, but the game has started: DraftKings no longer allows a change */
  locked: LineupPlayer[];
  before: number;      // expected points counting the players who are out as zero
  after: number;
  salary: number;
  complete: boolean;   // every swap has a pick
}

/** What to do about the players of one lineup who are ruled out. null: nobody is. */
export function planSwap(players: LineupPlayer[], pool: Map<string, PoolPlayer>, opts: { cap?: number; now?: number; chosen?: Record<number, string> } = {}): SwapPlan | null {
  const cap = opts.cap ?? 50_000, now = opts.now ?? Date.now();
  const row = [...players].sort((a, b) => a.slot_no - b.slot_no);
  const outs = row.filter((p) => isOut(pool.get(p.dk_id)));
  if (outs.length === 0) return null;
  const isLocked = (p: LineupPlayer) => started(pool.get(p.dk_id)?.kickoff_at, now);
  const locked = outs.filter(isLocked);
  const fix = outs.filter((p) => !isLocked(p));
  const kept = row.filter((p) => !fix.includes(p));
  const budget = cap - kept.reduce((s, p) => s + p.salary, 0);
  const inLineup = new Set(kept.map((p) => p.dk_id));
  const mean = (p: PoolPlayer) => p.dk_mean ?? 0;
  const candidates = (slot: Slot) => [...pool.values()]
    .filter((p) => !isOut(p) && !started(p.kickoff_at, now) && canFill(slot, p.pos) && !inLineup.has(p.dk_id))
    .sort((a, b) => mean(b) - mean(a));
  const lists = fix.map((p) => candidates((SLOTS[p.slot_no] ?? p.slot) as Slot));
  const cheapest = lists.map((l) => (l.length ? Math.min(...l.map((p) => p.salary)) : Infinity));

  // best picks within the money left: every pairing for one or two swaps, slot by slot beyond that
  let picks: (PoolPlayer | null)[] = fix.map(() => null);
  if (fix.length === 1) {
    picks = [lists[0].find((p) => p.salary <= budget) ?? null];
  } else if (fix.length === 2) {
    let best = -1;
    for (const a of lists[0].slice(0, 80)) {
      if (a.salary + cheapest[1] > budget) continue;
      const b = lists[1].find((p) => p.dk_id !== a.dk_id && a.salary + p.salary <= budget);
      if (b && mean(a) + mean(b) > best) { best = mean(a) + mean(b); picks = [a, b]; }
    }
    if (best < 0) picks = [lists[0].find((p) => p.salary + (Number.isFinite(cheapest[1]) ? cheapest[1] : 0) <= budget) ?? null, null];
  } else {
    let left = budget;
    const used = new Set<string>();
    fix.forEach((_, i) => {
      const reserve = cheapest.slice(i + 1).reduce((s, c) => s + (Number.isFinite(c) ? c : 0), 0);
      const p = lists[i].find((x) => !used.has(x.dk_id) && x.salary <= left - reserve) ?? null;
      picks[i] = p;
      if (p) { used.add(p.dk_id); left -= p.salary; }
    });
  }
  // the person's own choices replace the suggestions where they still fit
  fix.forEach((p, i) => {
    const want = opts.chosen?.[p.slot_no];
    const hit = want ? lists[i].find((x) => x.dk_id === want) : undefined;
    if (hit) picks[i] = hit;
  });

  const spent = (skip: number) => picks.reduce((s, p, i) => s + (i === skip || !p ? 0 : p.salary), 0);
  const swaps: SwapSlot[] = fix.map((p, i) => {
    const others = new Set(picks.filter((x, j) => x && j !== i).map((x) => x!.dk_id));
    return {
      slotNo: p.slot_no, slot: (SLOTS[p.slot_no] ?? p.slot) as Slot, out: p, pick: picks[i],
      options: lists[i].filter((x) => !others.has(x.dk_id) && x.salary <= budget - spent(i)).slice(0, 8),
    };
  });
  const salary = kept.reduce((s, p) => s + p.salary, 0) + spent(-1);
  const stillIn = kept.filter((p) => !isOut(pool.get(p.dk_id)));
  const before = stillIn.reduce((s, p) => s + (pool.get(p.dk_id)?.dk_mean ?? p.dk_mean ?? 0), 0);
  return {
    setId: row[0].set_id, lineupNo: row[0].lineup_no, swaps, locked, before,
    after: before + picks.reduce((s, p) => s + (p ? mean(p) : 0), 0), salary,
    complete: swaps.length > 0 && swaps.every((s) => s.pick) && salary <= cap,
  };
}

/** The nine DraftKings ids, in slot order, once a plan's picks are in. */
export function applySwap(players: LineupPlayer[], plan: SwapPlan): string[] {
  const pick = new Map(plan.swaps.map((s) => [s.slotNo, s.pick?.dk_id]));
  return [...players].sort((a, b) => a.slot_no - b.slot_no).map((p) => pick.get(p.slot_no) ?? p.dk_id);
}

/** "Mahomes + Kelce, Rice · vs Hill": the quarterback, who he is paired with, and who comes back from the other side. */
export function stackOf(players: { name: string; pos: string; team: string | null; opponent: string | null }[]): string {
  const last = (n: string) => n.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, "").split(" ").slice(-1)[0];
  const captain = (players as { slot?: string; name: string }[]).find((p) => p.slot === "CPT");
  if (captain) return `Captain ${last(captain.name)}`;       // a single-game lineup: the captain is what tells two apart
  const qb = players.find((p) => p.pos === "QB");
  if (!qb) return "";
  const mates = players.filter((p) => p !== qb && p.team === qb.team && p.pos !== "DST");
  const back = players.filter((p) => p.team === qb.opponent && p.pos !== "DST");
  if (mates.length === 0 && back.length === 0) return `${last(qb.name)}, on his own`;
  return `${last(qb.name)}${mates.length ? ` + ${mates.map((p) => last(p.name)).join(", ")}` : ""}${back.length ? ` · vs ${back.map((p) => last(p.name)).join(", ")}` : ""}`;
}

// ---- the DraftKings entries file -------------------------------------------------
/** One line of CSV, honouring quotes (contest names carry commas). */
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export interface ParsedEntry { entry_id: string; contest_id: string | null; contest_name: string | null; entry_fee: string | null; players: string[] | null }

/** Read a DraftKings entries file (Lineups → Edit Entries → Download). The file also
 *  carries instructions and the player list beside and below the entries: only rows
 *  with an entry id are entries. A roster cell is "Name (id)" the bare id, or "Name (id) (LOCKED)". */
export function parseEntriesCsv(text: string): { entries: ParsedEntry[]; problem?: string } {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).map(csvLine);
  const at = rows.findIndex((r) => r.some((c) => /^entry id$/i.test(c)));
  if (at < 0) return { entries: [], problem: "That isn't a DraftKings entries file: it has no \"Entry ID\" column. On DraftKings choose Lineups, then Edit Entries, then Download." };
  const head = rows[at].map((c) => c.toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const idCol = col("entry id"), nameCol = col("contest name"), contestCol = col("contest id"), feeCol = col("entry fee");
  const first = Math.max(idCol, nameCol, contestCol, feeCol) + 1;
  const roster: number[] = [];
  for (let i = first; i < head.length && head[i] !== "" && roster.length < 9; i++) roster.push(i);
  if (roster.length !== 9) return { entries: [], problem: "This entries file isn't for a classic nine-player contest. Showdown entries aren't supported yet." };
  const id = (cell: string | undefined): string | null => {
    // "Name (id)", the bare id, or "Name (id) (LOCKED)" once his game has started
    const m = (cell ?? "").match(/\((\d+)\)/) ?? (cell ?? "").match(/^(\d+)$/);
    return m ? m[1] : null;
  };
  const entries: ParsedEntry[] = [];
  for (const r of rows.slice(at + 1)) {
    const entryId = (r[idCol] ?? "").trim();
    if (!/^\d+$/.test(entryId)) continue;
    const ids = roster.map((i) => id(r[i]));
    entries.push({
      entry_id: entryId, contest_id: r[contestCol]?.trim() || null, contest_name: r[nameCol]?.trim() || null,
      entry_fee: (r[feeCol] ?? "").replace(/[$,\s]/g, "") || null,
      players: ids.every(Boolean) ? (ids as string[]) : null,
    });
  }
  if (entries.length === 0) return { entries, problem: "No entries in that file. Enter a contest on DraftKings first, then download the file again." };
  return { entries };
}

const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The file to hand back to DraftKings (Lineups → Edit Entries → Upload): one row
 *  per entry that holds a lineup, players by id in slot order. */
export function toEntriesCsv(entries: DkEntry[], lineupIds: (e: DkEntry) => string[] | null): { csv: string; rows: number } {
  const lines = [["Entry ID", "Contest Name", "Contest ID", "Entry Fee", ...SLOTS].join(",")];
  for (const e of entries) {
    const ids = lineupIds(e);
    if (!ids || ids.length !== 9) continue;
    lines.push([e.entry_id, quote(e.contest_name ?? ""), e.contest_id ?? "", e.entry_fee != null ? `$${e.entry_fee}` : "", ...ids].join(","));
  }
  return { csv: lines.join("\n") + "\n", rows: lines.length - 1 };
}
