import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, Loading, PosTag, Sheet, StatusPill } from "../components/ui";
import { usePool, useSaveLineup } from "../lib/api";
import { kickoff, pts, slateTitle, usd } from "../lib/format";
import { SLOTS, SLOT_LABEL, addPlayer, arrangeForLateSwap, canFill, check, removeAt, toDkCsv, value, type Lineup } from "../lib/lineup";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import type { PoolPlayer } from "../lib/types";

export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Builder() {
  const { slate, isLoading } = useCurrentSlate();
  const pool = usePool(slate?.id);
  const save = useSaveLineup();
  const { hand, setHand, say } = useStore();
  const [picking, setPicking] = useState<number | null>(null);
  const [text, setText] = useState("");

  const byId = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p])), [pool.data]);
  const lineup: Lineup = useMemo(() => hand.map((id) => (id ? byId.get(id) ?? null : null)), [hand, byId]);
  const c = check(lineup, slate?.salary_cap);
  const setLineup = (l: Lineup) => setHand(l.map((p) => p?.dk_id ?? null));

  if (isLoading || pool.isLoading) return <Loading />;
  if (!slate) return <Empty title="No DraftKings games loaded" why="A lineup needs this week's salaries." how={<Link className="accent" to="/more/settings">Add a salary file</Link>} />;

  const slot = picking == null ? null : SLOTS[picking];
  const taken = new Set(hand.filter(Boolean));
  const choices = slot == null ? [] : (pool.data ?? [])
    .filter((p) => p.dk_mean != null && canFill(slot, p.pos) && !taken.has(p.dk_id) && (!text || p.name.toLowerCase().includes(text.toLowerCase())))
    .sort((a, b) => (b.dk_mean ?? 0) - (a.dk_mean ?? 0)).slice(0, 80);

  function choose(p: PoolPlayer) {
    const next = lineup.slice();
    if (picking != null && next[picking] === null) next[picking] = p;
    else { const res = addPlayer(lineup, p); if (res.error) return say(res.error, true); return setLineup(res.lineup); }
    setLineup(next);
    setPicking(null);
    setText("");
  }
  function finish(kind: "save" | "file") {
    const ready = arrangeForLateSwap(lineup);
    const ids = ready.map((p) => p!.dk_id);
    if (kind === "file") return download(`bigsurf-lineup-week${slate!.week}.csv`, toDkCsv([ids]));
    save.mutate({ slate_id: slate!.id, players: ids }, {
      onSuccess: () => { setLineup(ready); say("Lineup saved"); },
      onError: (e) => say(`Couldn't save the lineup — ${e.message}`, true),
    });
  }

  return (
    <div className="stack stack--tight">
      <div>
        <p className="eyebrow">NFL · {slateTitle(slate.starts_at, 0)}</p>
        <h1 className="title">Build a lineup</h1>
      </div>
      <section className="card card--pad" aria-label="Lineup summary">
        <dl className="kv">
          <div><dt>Budget left</dt><dd className={`big num ${c.left < 0 ? "bad" : ""}`}>{usd(c.left)}</dd></div>
          <div><dt>Expected points</dt><dd className="big big--accent num">{pts(c.expected)}</dd></div>
        </dl>
        <progress className={`bar ${c.left < 0 ? "bar--over" : ""}`} max={slate.salary_cap} value={Math.min(c.salary, slate.salary_cap)} aria-label="Budget used" />
        <p className="small muted">{c.perOpenSpot != null ? `${usd(c.perOpenSpot)} per open spot · ` : ""}{c.filled} of 9 players · locks {kickoff(slate.starts_at)}</p>
        {c.problems.map((m) => <p key={m} className="small bad" role="alert">{m}</p>)}
      </section>

      <section className="card" aria-label="Roster">
        {SLOTS.map((s, i) => {
          const p = lineup[i];
          return (
            <div className="prow" key={i}>
              <span className="tag">{SLOT_LABEL[s]}</span>
              {p ? (
                <>
                  <div className="grow">
                    <p className="pname ellipsis">{p.name} <StatusPill status={p.dk_status} /></p>
                    <p className="pmeta ellipsis">{p.team} vs {p.opponent} · {kickoff(p.kickoff_at)}</p>
                  </div>
                  <div className="inline">
                    <p className="pnum num">{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                    <button className="btn btn--sm btn--quiet" onClick={() => setLineup(removeAt(lineup, i))} aria-label={`Remove ${p.name}`}>Remove</button>
                  </div>
                </>
              ) : (
                <>
                  <button className="grow" onClick={() => setPicking(i)}>
                    <p className="add">Add player</p>
                    <p className="pmeta">{s === "FLEX" ? "Any position · tap to choose" : "Tap to choose"}</p>
                  </button>
                  <span />
                </>
              )}
            </div>
          );
        })}
      </section>
      <div className="sticky-cta">
        <button className="btn btn--cta" disabled={!c.complete || save.isPending} onClick={() => finish("save")}>
          {save.isPending ? "Saving…" : c.complete ? "Save lineup" : c.filled === 9 ? "Fix the lineup to save" : `${9 - c.filled} more to pick`}
        </button>
      </div>
      <div className="inline">
        <button className="btn grow" disabled={!c.complete} onClick={() => finish("file")}>Download for DraftKings</button>
        <button className="btn btn--danger" disabled={c.filled === 0} onClick={() => setLineup(SLOTS.map(() => null))}>Clear lineup</button>
      </div>

      {slot != null && (
        <Sheet title={slot === "FLEX" ? "Choose a player — any position" : `Choose a ${SLOT_LABEL[slot]}`} onClose={() => { setPicking(null); setText(""); }}>
          <div className="stack stack--tight">
            <input className="input" type="search" placeholder="Search" aria-label="Search players" value={text} onChange={(e) => setText(e.target.value)} />
            <div>
              {choices.map((p) => (
                <button className="prow" key={p.dk_id} onClick={() => choose(p)}>
                  <PosTag pos={p.pos} />
                  <div className="grow">
                    <p className="pname ellipsis">{p.name} <StatusPill status={p.dk_status} /></p>
                    <p className="pmeta ellipsis">{p.team} vs {p.opponent} · {pts(value(p), 2)} per $1k</p>
                  </div>
                  <p className={`pnum num ${p.salary > c.left ? "bad" : ""}`}>{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                </button>
              ))}
              {choices.length === 0 && <p className="muted small">Nobody matches.</p>}
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
