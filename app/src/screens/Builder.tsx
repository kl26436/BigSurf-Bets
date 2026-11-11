import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, Facts, Icon, Loading, PlayerName, PosTag, Sheet } from "../components/ui";
import { usePool, useSaveLineup } from "../lib/api";
import { kickoff, pts, slateTitle, usd } from "../lib/format";
import { SLOTS, SLOT_LABEL, addPlayer, arrangeForLateSwap, check, handKey, pickerChoices, removeAt, toDkCsv, value, type Lineup, type PickSort } from "../lib/lineup";
import { useSheet, useTitle, useWide } from "../lib/nav";
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

const PICK_SORTS: Record<PickSort, string> = { points: "Points", value: "Value", cheapest: "Cheapest" };

export function Builder() {
  const { slate, isLoading } = useCurrentSlate();
  const pool = usePool(slate?.id);
  const save = useSaveLineup();
  const { hand, setHand, savedHand, setSavedHand, say } = useStore();
  const [picking, openPicker, closePicker] = useSheet<number>("pick");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<PickSort>("points");
  const [fits, setFits] = useState(true);
  const [name, setName] = useState("");
  // on a laptop the picker sits beside the lineup: the spot being filled is plain state, not a sheet
  const wide = useWide();
  const [focus, setFocus] = useState<number | null>(null);
  useTitle("Build a lineup");

  const byId = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p])), [pool.data]);
  const lineup: Lineup = useMemo(() => hand.map((id) => (id ? byId.get(id) ?? null : null)), [hand, byId]);
  const c = check(lineup, slate?.salary_cap);
  const setLineup = (l: Lineup) => setHand(l.map((p) => p?.dk_id ?? null));

  if (isLoading || pool.isLoading) return <Loading />;
  if (!slate) return <Empty title="No DraftKings games loaded" why="A lineup needs this week's salaries." how={<Link className="accent" to="/more/settings">Add a salary file</Link>} />;

  const active = wide ? (focus != null && lineup[focus] === null ? focus : null) : picking;
  const slot = active == null ? null : SLOTS[active];
  const openSlots = SLOTS.filter((_, i) => lineup[i] === null);
  const taken = new Set(hand.filter((id): id is string => !!id));
  // everyone who can fill the slot (beside the lineup: any open spot), then the ones the budget allows: the whole list, never a top-N
  const everyone = slot != null ? pickerChoices(pool.data ?? [], slot, taken, { text, sort })
    : wide && openSlots.length > 0 ? pickerChoices(pool.data ?? [], openSlots, taken, { text, sort }) : [];
  const choices = fits ? everyone.filter((p) => p.salary <= c.left) : everyone;
  // the same nine as the last save: saving again would only make a duplicate
  const saved = c.complete && savedHand?.key === handKey(hand) ? savedHand : null;
  const budget = `${usd(c.left)} left${c.perOpenSpot != null ? ` · ${usd(c.perOpenSpot)} per open spot` : ""}`;

  function closePick() {
    setText("");
    closePicker();
  }
  function choose(p: PoolPlayer) {
    if (active != null && lineup[active] === null) {
      const next = lineup.slice();
      next[active] = p;
      setLineup(next);
    } else {
      const res = addPlayer(lineup, p);
      if (res.error) return say(res.error, true);
      setLineup(res.lineup);
    }
    if (wide) { setText(""); setFocus(null); } else closePick();
  }
  function finish(kind: "save" | "file") {
    const ready = arrangeForLateSwap(lineup);
    const ids = ready.map((p) => p!.dk_id);
    if (kind === "file") return download(`bigsurf-lineup-week${slate!.week}.csv`, toDkCsv([ids]));
    const label = name.trim();
    save.mutate({ slate_id: slate!.id, players: ids, label: label || undefined }, {
      onSuccess: (setId) => {
        setLineup(ready);
        setSavedHand({ key: handKey(ids), setId: Number(setId), label: label || null });
        setName("");
        say("Lineup saved");
      },
      onError: (e) => say(`Couldn't save the lineup — ${e.message}`, true),
    });
  }

  const left = (
    <>
      <section className="card card--pad" aria-label="Lineup summary">
        <dl className="kv">
          <div><dt>Budget left</dt><dd className={`big num ${c.left < 0 ? "bad" : ""}`}>{usd(c.left)}</dd></div>
          <div><dt>Expected points</dt><dd className="big big--accent num">{pts(c.expected)}</dd></div>
        </dl>
        <progress className={`bar ${c.left < 0 ? "bar--over" : ""}`} max={slate.salary_cap} value={Math.min(c.salary, slate.salary_cap)} aria-label="Budget used" />
        <Facts items={[c.perOpenSpot != null ? `${usd(c.perOpenSpot)} per open spot` : null, `${c.filled} of 9 players`, `locks ${kickoff(slate.starts_at)}`]} />
        {c.problems.map((m) => <p key={m} className="small bad" role="alert">{m}</p>)}
      </section>

      <section className="card" aria-label="Roster">
        {SLOTS.map((s, i) => {
          const p = lineup[i];
          return (
            <div className={`prow prow--pick ${wide && active === i ? "prow--focus" : ""}`} key={i}>
              <span className="tag">{SLOT_LABEL[s]}</span>
              {p ? (
                <>
                  <div className="grow">
                    <PlayerName name={p.name} status={p.dk_status} />
                    <p className="pmeta ellipsis">{p.team} vs {p.opponent} · {kickoff(p.kickoff_at)}</p>
                  </div>
                  <p className="pnum num">{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                  <button className="iconbtn" onClick={() => setLineup(removeAt(lineup, i))} aria-label={`Remove ${p.name}`}><Icon name="x" /></button>
                </>
              ) : (
                <button className="grow prow__open" aria-pressed={wide ? active === i : undefined} onClick={() => (wide ? setFocus(active === i ? null : i) : openPicker(i))}>
                  <p className="add">Add player</p>
                  <p className="pmeta">{wide ? (active === i ? "Choosing for this spot" : s === "FLEX" ? "Any position. Click to choose for this spot" : "Click to choose for this spot") : s === "FLEX" ? "Any position. Tap to choose" : "Tap to choose"}</p>
                </button>
              )}
            </div>
          );
        })}
      </section>
      {!saved && (
        <label className="field"><span>Name</span>
          <input className="input" type="text" maxLength={60} placeholder="Optional — to tell this lineup from the others" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <div className="sticky-cta">
        {/* the budget follows the scroll with the button: it is what every pick is checked against */}
        <p className={`small num sticky-cta__note ${c.left < 0 ? "bad" : "muted"}`} role="status">{budget} · {pts(c.expected)} expected</p>
        {saved ? (
          <Link className="btn btn--cta" to={`/lineups/${saved.setId}`}>Saved — open it</Link>
        ) : (
          <button className="btn btn--cta" disabled={!c.complete || save.isPending} onClick={() => finish("save")}>
            {save.isPending ? "Saving…" : c.complete ? "Save lineup" : c.filled === 9 ? "Fix the lineup to save" : `${9 - c.filled} more to pick`}
          </button>
        )}
      </div>
      <div className="inline">
        <button className="btn grow" disabled={!c.complete} onClick={() => finish("file")}>Download for DraftKings</button>
        <button className="btn btn--danger" disabled={c.filled === 0} onClick={() => setLineup(SLOTS.map(() => null))}>Clear lineup</button>
      </div>
    </>
  );
  const picker = (
          <div className="stack stack--tight">
            <p className={`small num ${c.left < 0 ? "bad" : "muted"}`}>{budget}</p>
            <input className="input" type="search" placeholder="Search a player or team" aria-label="Search players" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="chips" role="group" aria-label="Sort by">
              {(Object.keys(PICK_SORTS) as PickSort[]).map((k) => (
                <button key={k} className="chip" aria-pressed={sort === k} onClick={() => setSort(k)}>{PICK_SORTS[k]}</button>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={fits} onChange={(e) => setFits(e.target.checked)} />Only players I can afford</label>
            <p className="small muted">{fits && choices.length < everyone.length ? `${choices.length} of ${everyone.length} fit the budget left` : `${everyone.length} to choose from`}</p>
            <div>
              {choices.map((p) => (
                <button className="prow" key={p.dk_id} onClick={() => choose(p)}>
                  <PosTag pos={p.pos} />
                  <div className="grow">
                    <PlayerName name={p.name} status={p.dk_status} />
                    <p className="pmeta ellipsis">{p.team} vs {p.opponent} · {pts(value(p), 2)} per $1k</p>
                  </div>
                  <p className={`pnum num ${p.salary > c.left ? "bad" : ""}`}>{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                </button>
              ))}
              {choices.length === 0 && <p className="muted small">{everyone.length > 0 ? "Nobody here fits the budget left. Untick the box to see everyone." : "Nobody matches."}</p>}
            </div>
          </div>
  );
  const pickTitle = slot == null ? "Choose a player" : slot === "FLEX" ? "Choose a player — any position" : `Choose a ${SLOT_LABEL[slot]}`;

  return (
    <div className="stack stack--tight">
      <div>
        <p className="eyebrow">NFL · {slateTitle(slate.starts_at, 0)}</p>
        <h1 className="title">Build a lineup</h1>
      </div>
      {wide ? (
        <div className="panes">
          <div className="stack stack--tight">{left}</div>
          <section className="card card--pad pane" aria-label="Choose a player">
            <div className="card__head"><h2 className="h2">{openSlots.length === 0 ? "All nine spots are filled" : pickTitle}</h2>
              {slot != null && <button className="btn btn--sm btn--quiet" onClick={() => setFocus(null)}>Every open spot</button>}</div>
            {openSlots.length === 0 ? <p className="small muted">Remove a player on the left to change him.</p> : picker}
          </section>
        </div>
      ) : left}
      {!wide && slot != null && <Sheet title={pickTitle} onClose={closePick}>{picker}</Sheet>}
    </div>
  );
}
