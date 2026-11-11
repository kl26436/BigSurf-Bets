// Entered lineups with a player who has since been ruled out.
import { usePool, useSetsDetail } from "./api";
import { isOut } from "./swap";
import type { LineupSet, Slate } from "./types";

export interface Scratches {
  /** lineups marked as entered across the sets given */
  entered: number;
  /** of those, how many have a ruled-out player */
  hit: number;
  names: string[];
}

/** null while loading, or when nothing is entered for games that are still to come. */
export function useScratches(slate: Slate | null | undefined, sets: LineupSet[]): Scratches | null {
  const entered = sets.filter((s) => s.entered && !s.archived_at);
  const many = useSetsDetail(entered.map((s) => s.id));
  const pool = usePool(slate?.id);
  if (!slate || entered.length === 0 || !many.data || !pool.data?.length) return null;
  const byId = new Map(pool.data.map((p) => [p.dk_id, p]));
  const played = new Set(many.data.lineups.filter((l) => l.entered).map((l) => `${l.set_id}:${l.lineup_no}`));
  const out = slate.upcoming ? many.data.players.filter((p) => played.has(`${p.set_id}:${p.lineup_no}`) && isOut(byId.get(p.dk_id))) : [];
  return { entered: played.size, hit: new Set(out.map((p) => `${p.set_id}:${p.lineup_no}`)).size, names: [...new Set(out.map((p) => p.name))] };
}
