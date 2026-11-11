// The price board and the bet record.
//
// The board answers "where is the best price for this bet, at a book I can use?"
// for every game and every player line, not only the ones that beat the sharp price.
// The record answers "is following this making money, and am I beating the closing price?"
import { decimalToAmerican } from "./stake";
import type { Bet, LineQuote, PropEdge } from "./types";

export const SHARP = "pinnacle";

export interface BoardSide {
  outcome: LineQuote["outcome"];
  /** the number as quoted for this side (null: to win) */
  line: number | null;
  fair: number | null;
  /** best price at a book the person can bet at (null: none of theirs quotes it) */
  best: LineQuote | null;
  /** every book's price, best first */
  all: LineQuote[];
}
export interface BoardMarket { market: LineQuote["market"]; number: number; sides: BoardSide[]; books: number }
export interface BoardGame { game_id: string; home_team: string; away_team: string; kickoff_at: string | null; markets: BoardMarket[] }

const ORDER: LineQuote["market"][] = ["spread", "total", "moneyline"];
const FIRST = new Set(["away", "over"]);     // listed first: the away team, as "A at B" reads, and the over

/** One card per game: the spread and total at the number most books quote, and the price to win. */
export function boardGames(quotes: LineQuote[], books: string[]): BoardGame[] {
  const mine = new Set(books);
  const games = new Map<string, LineQuote[]>();
  for (const q of quotes) games.set(q.game_id, [...(games.get(q.game_id) ?? []), q]);
  const out: BoardGame[] = [];
  for (const rows of games.values()) {
    const markets: BoardMarket[] = [];
    for (const market of ORDER) {
      const byNumber = new Map<number, LineQuote[]>();
      for (const q of rows) if (q.market === market) byNumber.set(q.number, [...(byNumber.get(q.number) ?? []), q]);
      if (byNumber.size === 0) continue;
      // the main number: quoted by the most books; the sharp book breaks a tie
      const count = (qs: LineQuote[]) => new Set(qs.map((q) => q.bookmaker)).size + (qs.some((q) => q.bookmaker === SHARP) ? 0.5 : 0);
      const [number, qs] = [...byNumber.entries()].sort((a, b) => count(b[1]) - count(a[1]) || Math.abs(a[0]) - Math.abs(b[0]))[0];
      const sides: BoardSide[] = [...new Set(qs.map((q) => q.outcome))].sort((a, b) => Number(FIRST.has(b)) - Number(FIRST.has(a))).map((outcome) => {
        const all = qs.filter((q) => q.outcome === outcome).sort((a, b) => b.price_decimal - a.price_decimal);
        return { outcome, line: all[0].line, fair: all.find((q) => q.fair_prob != null)?.fair_prob ?? null,
          best: all.find((q) => mine.has(q.bookmaker) && q.bookmaker !== SHARP) ?? null, all };
      });
      markets.push({ market, number, sides, books: new Set(qs.map((q) => q.bookmaker)).size });
    }
    if (markets.length) out.push({ game_id: rows[0].game_id, home_team: rows[0].home_team, away_team: rows[0].away_team, kickoff_at: rows[0].kickoff_at, markets });
  }
  return out.sort((a, b) => (a.kickoff_at ?? "").localeCompare(b.kickoff_at ?? "") || a.game_id.localeCompare(b.game_id));
}

export interface PropPrice { bookmaker: string; price: number }
export interface BoardLine {
  key: string;
  player_id: string; player_name: string; team: string | null; game_id: string;
  stat: string; line: number;
  proj_mean: number | null; fair_over: number | null; model_over: number | null;
  /** best first; only books the person can bet at */
  over: PropPrice[]; under: PropPrice[];
  books: number;
}

/** One row per player, stat and number, with the best over and under among the person's books. */
export function boardPlayers(props: PropEdge[], books: string[], opts: { text?: string; stat?: string } = {}): BoardLine[] {
  const mine = new Set(books);
  const needle = (opts.text ?? "").trim().toLowerCase();
  const by = new Map<string, BoardLine>();
  for (const e of props) {
    if (opts.stat && e.stat !== opts.stat) continue;
    const name = e.player_name ?? e.player_id;
    if (needle && !name.toLowerCase().includes(needle) && (e.team ?? "").toLowerCase() !== needle) continue;
    const key = `${e.player_id}|${e.stat}|${e.line}`;
    let row = by.get(key);
    if (!row) {
      row = { key, player_id: e.player_id, player_name: name, team: e.team, game_id: e.game_id, stat: e.stat, line: e.line,
        proj_mean: e.proj_mean, fair_over: e.fair_over, model_over: e.model_over, over: [], under: [], books: 0 };
      by.set(key, row);
    }
    row.books += 1;
    row.fair_over ??= e.fair_over;
    if (!mine.has(e.bookmaker) || e.bookmaker === SHARP) continue;
    if ((e.over_decimal ?? 0) > 1) row.over.push({ bookmaker: e.bookmaker, price: e.over_decimal! });
    if ((e.under_decimal ?? 0) > 1) row.under.push({ bookmaker: e.bookmaker, price: e.under_decimal! });
  }
  const rows = [...by.values()].filter((r) => r.over.length + r.under.length > 0);
  for (const r of rows) { r.over.sort((a, b) => b.price - a.price); r.under.sort((a, b) => b.price - a.price); }
  // the lines the model has most to say about first, then by name: stable while typing
  return rows.sort((a, b) => (b.proj_mean ?? 0) - (a.proj_mean ?? 0) || a.player_name.localeCompare(b.player_name) || a.stat.localeCompare(b.stat) || a.line - b.line);
}

// ---- writing a bet down ------------------------------------------------------------
/** What the "record this bet" sheet starts from. */
export interface BetDraft {
  kind: Bet["kind"];
  description: string;
  bookmaker: string;
  price_decimal: number | null;
  game_id?: string | null;
  market?: string | null;
  number?: number | null;
  outcome?: Bet["outcome"];
  player_id?: string | null;
  fair_prob?: number | null;
  stake?: number | null;
}

/** "+135" / "-110" / "2.35" → a decimal price (null when it is not a price). */
export function parsePrice(text: string): number | null {
  const t = text.trim().replace(/−/g, "-");
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  if (/^[+-]/.test(t) || Math.abs(v) >= 100) {                 // American
    if (Math.abs(v) < 100) return null;
    return v > 0 ? 1 + v / 100 : 1 + 100 / -v;
  }
  return v > 1 ? v : null;                                     // decimal
}
export const priceText = (d: number | null | undefined) => {
  if (d == null || !(d > 1)) return "";
  const a = decimalToAmerican(d);
  return a > 0 ? `+${a}` : `${a}`;
};

// ---- the record ----------------------------------------------------------------------
export interface BetRecord {
  open: number; openStake: number;
  settled: number; won: number; lost: number; returned: number;     // returned: stake back (a tie with the number)
  staked: number; profit: number; roi: number | null;
  /** bets with a closing price, how many beat it, and the average margin over it */
  closeN: number; closeBeat: number; closeAvg: number | null;
}

export function betRecord(bets: Bet[]): BetRecord {
  const settled = bets.filter((b) => b.result !== "open");
  const counted = settled.filter((b) => b.result !== "void");
  const staked = counted.reduce((s, b) => s + b.stake, 0);
  const profit = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const close = bets.filter((b) => b.beat_close != null);
  return {
    open: bets.length - settled.length, openStake: bets.filter((b) => b.result === "open").reduce((s, b) => s + b.stake, 0),
    settled: settled.length, won: settled.filter((b) => b.result === "won").length, lost: settled.filter((b) => b.result === "lost").length,
    returned: settled.filter((b) => b.result === "void").length,
    staked, profit, roi: staked > 0 ? profit / staked : null,
    closeN: close.length, closeBeat: close.filter((b) => (b.beat_close ?? 0) > 0).length,
    closeAvg: close.length ? close.reduce((s, b) => s + (b.beat_close ?? 0), 0) / close.length : null,
  };
}
