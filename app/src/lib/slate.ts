import { useSlates } from "./api";
import { useStore } from "./store";
import type { Slate } from "./types";

/** The DraftKings games being looked at: the ones picked on this visit, else the
 *  newest upcoming classic set, else the newest of any. `slates` lists what can be picked, newest first. */
export function useCurrentSlate(): { slate: Slate | undefined; slates: Slate[]; isLoading: boolean; pick: (id: number | null) => void } {
  const q = useSlates();
  const { slateId, setSlateId } = useStore();
  const classic = (q.data ?? []).filter((s) => s.slate_type === "classic");
  const upcoming = classic.filter((s) => s.upcoming).sort((a, b) => Date.parse(b.imported_at) - Date.parse(a.imported_at));
  const fallback = upcoming[0] ?? classic[0];
  return { slate: classic.find((s) => s.id === slateId) ?? fallback, slates: classic, isLoading: q.isLoading, pick: (id) => setSlateId(id === fallback?.id ? null : id) };
}
