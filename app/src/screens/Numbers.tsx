import { Empty, ErrorNote, Facts, Loading, PosTag } from "../components/ui";
import { useModelRuns, useOverrides, useSetOverride } from "../lib/api";
import { ago, pts, signed } from "../lib/format";
import { useTitle } from "../lib/nav";
import { useStore } from "../lib/store";
import type { Override } from "../lib/types";

/** Every expected-points number you replaced with your own, with a way back to the model's. */
function Changes({ rows }: { rows: Override[] }) {
  const clear = useSetOverride();
  const { say } = useStore();
  const now = rows.filter((o) => o.this_week), old = rows.filter((o) => !o.this_week);
  return (
    <section aria-label="Your changes" className="stack stack--tight">
      <div className="card__head"><h2 className="h2">Your changes</h2><span className="small muted">Expected points you set yourself</span></div>
      {now.length === 0 ? (
        <Empty title="No changes this week" why="Every player is on the model's number." how="To set your own, open a player on the Players tab and tap his expected points." />
      ) : (
        <div className="card">
          {now.map((o) => (
            <div className="prow" key={o.player_id}>
              <PosTag pos={o.pos} />
              <div className="grow"><p className="pname ellipsis">{o.name}</p>
                <Facts items={[o.team && o.opponent ? `${o.team} vs ${o.opponent}` : o.team, o.model_dk_mean != null ? `model says ${pts(o.model_dk_mean)}` : "no model number", `set ${ago(o.updated_at)}`]} /></div>
              <p className="pnum num">{pts(o.dk_mean)}<small>{o.model_dk_mean != null ? signed(o.dk_mean - o.model_dk_mean) : "yours"}</small></p>
              <button className="btn btn--sm btn--quiet" disabled={clear.isPending} onClick={() => clear.mutate({ season: o.season, week: o.week, player_id: o.player_id, dk_mean: null },
                { onSuccess: () => say(`${o.name} is back on the model's number`), onError: (e) => say(`Couldn't change that — ${e.message}`, true) })}>Undo</button>
            </div>
          ))}
        </div>
      )}
      {now.length > 0 && <p className="small muted">Lineups built from now on use your numbers. Sets already built keep the numbers they were built with.</p>}
      {old.length > 0 && <p className="small muted">{old.length} {old.length === 1 ? "change" : "changes"} from earlier weeks {old.length === 1 ? "is" : "are"} kept for the record and no longer used.</p>}
    </section>
  );
}

export function Numbers() {
  const overrides = useOverrides();
  const runs = useModelRuns();
  useTitle("The numbers");
  if (overrides.isLoading || runs.isLoading) return <Loading />;
  if (overrides.error) return <ErrorNote error={overrides.error} />;
  const list = runs.data ?? [];
  return (
    <div className="stack">
      <div><h1 className="title">The numbers</h1>
        <p className="small muted">Expected points come from the model, except where you put in your own.</p></div>
      <Changes rows={overrides.data ?? []} />
      <section aria-label="When the numbers were worked out" className="stack stack--tight">
        <div className="card__head"><h2 className="h2">When they were worked out</h2><span className="small muted">Newest first</span></div>
        {list.length === 0 ? <Empty title="Not worked out yet" why="Expected points are worked out after each refresh of stats, statuses or prices." /> : (
          <div className="card card--pad scroll-x">
            <table className="table">
              <thead><tr><th scope="col">When</th><th scope="col">Week</th><th scope="col">Players</th><th scope="col">Ruled out</th><th scope="col">Model</th></tr></thead>
              <tbody>{list.map((r, i) => (
                <tr key={r.id}><td className={i === 0 ? "strong" : undefined}>{ago(r.created_at)}</td><td className="num">{r.week}</td><td className="num">{r.n_players ?? "–"}</td>
                  <td className="num">{r.n_ruled_out ?? "–"}</td><td>{r.model_version}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="small muted">A new set is worked out only when something it depends on has changed: a player's status, the stats, a price, or the salary file.</p>
      </section>
    </div>
  );
}
