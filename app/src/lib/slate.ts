import { useSlates } from "./api";
import { useStore } from "./store";
import type { Slate } from "./types";

/** The DraftKings games being looked at: the ones picked on this visit, else the
 *  newest upcoming full-day set, else the newest of those. Single-game (captain) contests are
 *  never the default: they are picked from the list. `slates` lists what can be picked, newest first. */
export function useCurrentSlate(): { slate: Slate | undefined; slates: Slate[]; isLoading: boolean; pick: (id: number | null) => void } {
  const q = useSlates();
  const { slateId, setSlateId } = useStore();
  const classic = (q.data ?? []).filter((s) => s.slate_type === "classic");
  const upcoming = classic.filter((s) => s.upcoming).sort((a, b) => Date.parse(b.imported_at) - Date.parse(a.imported_at));
  const fallback = upcoming[0] ?? classic[0];
  const single = (q.data ?? []).filter((s) => s.slate_type === "showdown");
  const all = [...classic, ...single].sort((a, b) => Date.parse(b.starts_at ?? b.imported_at) - Date.parse(a.starts_at ?? a.imported_at));
  const first = fallback ?? single.find((s) => s.upcoming) ?? single[0];
  return { slate: all.find((s) => s.id === slateId) ?? first, slates: all, isLoading: q.isLoading, pick: (id) => setSlateId(id === first?.id ? null : id) };
}
