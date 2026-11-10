const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 90) return "just now";
  if (abs < 5400) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 129600) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function kickoff(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function dayName(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("en-US", { weekday: "long" }) : "";
}

export const pts = (v: number | null | undefined, d = 1) => (v == null ? "–" : Number(v).toFixed(d));
export const usd = (v: number | null | undefined) => (v == null ? "–" : `$${Math.round(Number(v)).toLocaleString()}`);
export const pct = (v: number | null | undefined, d = 0) => (v == null ? "–" : `${(Number(v) * 100).toFixed(d)}%`);
export const odds = (a: number | null | undefined) => (a == null ? "–" : a > 0 ? `+${a}` : `${a}`);
export const signed = (v: number | null | undefined, d = 1) => (v == null ? "–" : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(d)}`);

const BOOKS: Record<string, string> = {
  pinnacle: "Pinnacle", circa: "Circa", draftkings: "DraftKings", betmgm: "BetMGM", fanduel: "FanDuel", caesars: "Caesars",
};
export const bookName = (slug: string) => BOOKS[slug] ?? slug;

const STATS: Record<string, string> = {
  passing_yards: "Passing yards", attempts: "Pass attempts", completions: "Completions", passing_tds: "Passing touchdowns",
  interceptions: "Interceptions", rushing_yards: "Rushing yards", carries: "Carries", receiving_yards: "Receiving yards",
  receptions: "Catches", anytime_td: "Touchdown scored",
};
export const statName = (s: string) => STATS[s] ?? s.replace(/_/g, " ");

/** "Sunday games" — slates are named by day, never called slates. */
export function slateTitle(startsAt: string | null, nGames: number): string {
  const day = dayName(startsAt);
  return `${day || "Upcoming"} games${nGames ? ` · ${nGames}` : ""}`;
}

export function statusLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = s.toUpperCase();
  if (k === "Q" || k === "QUESTIONABLE") return "Questionable";
  if (k === "D" || k === "DOUBTFUL") return "Doubtful";
  if (k === "O" || k === "OUT") return "Out";
  if (k === "IR") return "Injured reserve";
  return s;
}
