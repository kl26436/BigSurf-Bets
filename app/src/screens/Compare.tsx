import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Empty, ErrorNote, Loading, PosTag } from "../components/ui";
import { useSet } from "../lib/api";
import { pct, pts } from "../lib/format";
import { describeSettings, exposure } from "../lib/lineup";
import { useTitle } from "../lib/nav";
import type { LineupPlayer, LineupSet } from "../lib/types";
import { setName } from "./Lineups";

/** Two sets side by side: what each is built to do, and where they lean on different players. */
export function Compare() {
  const { a, b } = useParams();
  const A = useSet(Number(a)), B = useSet(Number(b));
  useTitle("Compare sets");
  const rows = useMemo(() => {
    const ea = exposure(A.data?.players ?? []), eb = exposure(B.data?.players ?? []);
    const all = new Map<string, LineupPlayer>([...ea.values(), ...eb.values()].map((e) => [e.row.dk_id, e.row]));
    return [...all.values()].map((p) => ({ p, a: ea.get(p.dk_id)?.share ?? 0, b: eb.get(p.dk_id)?.share ?? 0 }))
      .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
  }, [A.data, B.data]);

  if (A.isLoading || B.isLoading) return <Loading />;
  if (A.error || B.error) return <ErrorNote error={A.error ?? B.error} />;
  const sa = A.data?.set, sb = B.data?.set;
  if (!sa || !sb) return <Empty title="One of these sets is gone" how={<Link className="accent" to="/lineups">Back to Lineups</Link>} />;
  const num = (s: LineupSet, k: string) => (s.summary as Record<string, number> | null)?.[k];
  const entered = (d: typeof A.data) => (d?.lineups ?? []).filter((l) => l.entered).length;
  const line = (label: string, f: (s: LineupSet, d: typeof A.data) => string, note?: string) => (
    <tr key={label}><td>{label}{note && <span className="small muted block">{note}</span>}</td><td className="num strong">{f(sa, A.data)}</td><td className="num strong">{f(sb, B.data)}</td></tr>
  );
  const both = rows.filter((r) => r.a > 0 && r.b > 0).length;

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Side by side</p>
        <h1 className="title">Compare sets</h1>
      </div>
      <section className="card card--pad scroll-x" aria-label="The two sets">
        <table className="table">
          <thead><tr><th scope="col">&nbsp;</th><th scope="col"><Link className="accent" to={`/lineups/${sa.id}`}>{setName(sa)}</Link></th><th scope="col"><Link className="accent" to={`/lineups/${sb.id}`}>{setName(sb)}</Link></th></tr></thead>
          <tbody>
            {line("Lineups", (s) => String(s.n_lineups))}
            {line("Entered", (_, d) => String(entered(d)))}
            {line("Expected points, average", (s) => pts(num(s, "avg_proj")))}
            {line("Best lineup of the set, on average", (s) => pts(num(s, "set_best_mean")), "What the set scores when you count its top lineup each time")}
            {line("Best lineup, in the top tenth of outcomes", (s) => pts(num(s, "set_best_p90")))}
            {line("Players used", (s) => String(num(s, "players_used") ?? "–"))}
            {line("Most any one player is used", (s) => (num(s, "max_exposure_pct") != null ? `${num(s, "max_exposure_pct")}%` : "–"))}
          </tbody>
        </table>
        <p className="small muted">{setName(sa)}: {describeSettings(sa).join(" · ") || "no build settings on record"}.</p>
        <p className="small muted">{setName(sb)}: {describeSettings(sb).join(" · ") || "no build settings on record"}.</p>
      </section>
      <section className="card card--pad scroll-x" aria-label="Where they differ">
        <div className="card__head"><h2 className="h2">Where they differ</h2><span className="small muted">{both} players are in both</span></div>
        <table className="table">
          <thead><tr><th scope="col">Share of lineups</th><th scope="col">{setName(sa)}</th><th scope="col">{setName(sb)}</th></tr></thead>
          <tbody>{rows.slice(0, 20).map((r) => (
            <tr key={r.p.dk_id}><td><span className="inline inline--row"><PosTag pos={r.p.pos} />{r.p.name}</span></td>
              <td className={`num ${r.a > r.b ? "strong" : "muted"}`}>{pct(r.a)}</td><td className={`num ${r.b > r.a ? "strong" : "muted"}`}>{pct(r.b)}</td></tr>
          ))}</tbody>
        </table>
        <p className="small muted">The 20 players the two sets disagree on most. A missing number means the set was changed after it was built.</p>
      </section>
    </div>
  );
}
