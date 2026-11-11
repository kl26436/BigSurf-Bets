// A DraftKings contest results file ("Export Lineups to CSV" on a finished contest).
//
// One file holds two lists side by side: every entry (rank, entry id, entry name,
// points, lineup) and every player (name, roster position, share of lineups, points).
// Big contests run to hundreds of thousands of rows, so the file is read on the
// device and only the useful part is sent on: your entries, where the field's scores
// fell, and each player's share of lineups.
import { csvLine } from "./swap";

export interface StandingsEntry { entry_id: string; entry_name: string; rank: number | null; points: number | null; lineup: string }
export interface StandingsPlayer { name: string; roster_position: string; pct_drafted: number | null; fpts: number | null }
export interface Standings {
  contest_key: string;
  n_entries: number;
  /** points it took to place: the best score, the top 1%, 10%, 25%, the middle, the worst */
  scores: { max: number; p99: number; p90: number; p75: number; p50: number; min: number } | null;
  entries: StandingsEntry[];          // yours
  ownership: StandingsPlayer[];
  /** how many different people entered (an entry name without its "(2/20)" count) */
  n_people: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]/g, "");
const number = (s: string | undefined): number | null => {
  const t = (s ?? "").replace(/[%,$\s]/g, "");
  return t !== "" && Number.isFinite(Number(t)) ? Number(t) : null;
};
/** "kevlap (3/20)" → "kevlap" */
export const person = (entryName: string) => entryName.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim();

/** → the parsed file, or `problem` saying what is wrong with it in plain words.
 *  Yours = an entry whose id is in `entryIds` (from your entries file) or whose name is `username`. */
export function parseStandingsCsv(text: string, fileName: string, mine: { username?: string; entryIds?: Set<string> } = {}): { standings?: Standings; problem?: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const at = lines.findIndex((l) => /entryid/i.test(l.replace(/\s/g, "")) && /rank/i.test(l));
  if (at < 0) {
    return { problem: /entry id/i.test(lines.slice(0, 10).join(" ")) && /contest name/i.test(lines.slice(0, 10).join(" "))
      ? "That is your entries file, not a contest's results. Add it on the Lineups tab. For results, open a finished contest on DraftKings and choose Export Lineups to CSV."
      : "That isn't a DraftKings contest results file: it has no \"EntryId\" column. Open a finished contest on DraftKings (the desktop site) and choose Export Lineups to CSV." };
  }
  const head = csvLine(lines[at]).map(norm);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const cRank = col("rank"), cId = col("entryid"), cName = col("entryname"), cPts = col("points"), cLineup = col("lineup");
  const cPlayer = col("player"), cPos = col("rosterposition"), cPct = col("%drafted", "drafted"), cFpts = col("fpts");
  if (cId < 0 || cPts < 0) return { problem: "That file is missing its EntryId or Points column, so it can't be read." };

  const user = (mine.username ?? "").trim().toLowerCase();
  const ids = mine.entryIds ?? new Set<string>();
  const entries: StandingsEntry[] = [];
  const ownership: StandingsPlayer[] = [];
  const scores: number[] = [];
  const people = new Set<string>();
  let n = 0, firstId = "";
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const r = csvLine(lines[i]);
    const id = r[cId] ?? "";
    if (/^\d+$/.test(id)) {
      n += 1;
      if (!firstId) firstId = id;
      const points = number(r[cPts]);
      if (points != null) scores.push(points);
      const name = cName >= 0 ? r[cName] ?? "" : "";
      const who = person(name);
      people.add(who.toLowerCase());
      if (ids.has(id) || (user !== "" && who.toLowerCase() === user)) {
        entries.push({ entry_id: id, entry_name: name, rank: number(r[cRank]), points, lineup: cLineup >= 0 ? r[cLineup] ?? "" : "" });
      }
    }
    if (cPlayer >= 0 && (r[cPlayer] ?? "") !== "") {
      ownership.push({ name: r[cPlayer], roster_position: cPos >= 0 ? r[cPos] ?? "" : "", pct_drafted: number(r[cPct]), fpts: number(r[cFpts]) });
    }
  }
  if (n === 0) return { problem: "No entries in that file. Results can be exported once the contest has started." };
  scores.sort((a, b) => b - a);
  const place = (share: number) => scores[Math.min(scores.length - 1, Math.floor(share * scores.length))];
  const key = fileName.match(/(\d{6,})/)?.[1] ?? `f${n}-${firstId}`;
  return { standings: {
    contest_key: key, n_entries: n, n_people: people.size,
    scores: scores.length ? { max: scores[0], p99: place(0.01), p90: place(0.1), p75: place(0.25), p50: place(0.5), min: scores[scores.length - 1] } : null,
    entries: entries.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)), ownership,
  } };
}

/** "top 3%" — where a rank falls in a field. */
export function topShare(rank: number | null, n: number): string {
  if (rank == null || n <= 0) return "";
  const share = rank / n;
  if (rank === 1) return "first";
  return share <= 0.001 ? "top 0.1%" : share < 0.01 ? `top ${(share * 100).toFixed(1)}%` : share <= 0.5 ? `top ${Math.ceil(share * 100)}%` : `bottom ${Math.max(1, Math.ceil((1 - share) * 100))}%`;
}

/** Money across contests: only ones with a fee and every entry's winnings typed in count. */
export function contestRecord(list: { paid: number | null; won: number | null; profit: number | null; n_mine: number | null }[]) {
  const settled = list.filter((c) => c.profit != null && (c.n_mine ?? 0) > 0);
  const paid = settled.reduce((a, c) => a + (c.paid ?? 0), 0), won = settled.reduce((a, c) => a + (c.won ?? 0), 0);
  return { n: settled.length, open: list.filter((c) => (c.n_mine ?? 0) > 0).length - settled.length, paid, won, profit: won - paid, roi: paid > 0 ? (won - paid) / paid : null };
}
