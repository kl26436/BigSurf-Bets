import { useSlates } from "./api";
import type { Slate } from "./types";

/** The DraftKings games in play: the newest upcoming classic set, else the newest of any. */
export function useCurrentSlate(): { slate: Slate | undefined; isLoading: boolean } {
  const q = useSlates();
  const classic = (q.data ?? []).filter((s) => s.slate_type === "classic");
  const upcoming = classic.filter((s) => s.upcoming).sort((a, b) => Date.parse(b.imported_at) - Date.parse(a.imported_at));
  return { slate: upcoming[0] ?? classic[0], isLoading: q.isLoading };
}
