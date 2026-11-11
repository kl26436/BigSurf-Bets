import { dayName } from "../lib/format";
import { useCurrentSlate } from "../lib/slate";
import type { Slate } from "../lib/types";

const label = (s: Slate) => `Week ${s.week} · ${dayName(s.starts_at) || "Upcoming"} games${s.n_games ? ` · ${s.n_games}` : ""}${s.upcoming ? "" : " · played"}`;

/** Which DraftKings games the screen is about. Only shown when there is more than one set of games to choose from. */
export function GamesPicker() {
  const { slate, slates, pick } = useCurrentSlate();
  if (!slate || slates.length < 2) return null;
  return (
    <label className="field">
      <span>Games</span>
      <select className="input" value={slate.id} onChange={(e) => pick(Number(e.target.value))} aria-label="Which games">
        {slates.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
      </select>
    </label>
  );
}
