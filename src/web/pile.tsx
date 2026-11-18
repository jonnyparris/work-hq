import { useEffect, useMemo, useState } from "react";
import type { Item } from "../shared/types.ts";
import { PILE_AGES, PILE_AGENT_MAX, PILE_SOURCES, type PileAge, type PileOp, type PileSource, pileCounts, pileDays, pileItems, pileOpText, pileSource } from "../shared/pile.ts";
import { api } from "./store.ts";
import { Icon, KIND_LABEL, Md } from "./ui.tsx";

const OPS: Array<{ op: PileOp; label: string; tone?: string }> = [
  { op: "drop", label: "Drop", tone: "danger" },
  { op: "today", label: "Today" },
  { op: "agent", label: "Agent: do it" },
  { op: "done", label: "Already done", tone: "good" },
  { op: "keep", label: "Keep for now", tone: "quiet" },
];

/**
 * "Sort the pile" (/pile): every proposed item, oldest first, filtered by where it came from and how old it is, with
 * tick-boxes and one bulk bar (shared/pile.ts, Hub.bulkItems). Separate from the card queue on purpose: a pile of 150
 * is a sorting job you sit down for, not 150 questions.
 */
export function PileView({ items, now, onOpen, selected }: { items: Item[]; now: Date; onOpen: (id: string) => void; selected?: string }) {
  const t = now.getTime();
  const [source, setSource] = useState<PileSource | undefined>();
  const [age, setAge] = useState<PileAge | undefined>();
  const [q, setQ] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  const counts = useMemo(() => pileCounts(items, t), [items, t]);
  const list = useMemo(() => pileItems(items, t, { source, age, q }), [items, t, source, age, q]);
  // Ticks on rows that left the list (sorted elsewhere, filtered out) don't count.
  const live = ticked.filter((id) => list.some((i) => i.id === id));
  // A ticked row that left Proposed (sorted in another tab, by a card) drops its tick, so it can't come back ticked.
  useEffect(() => {
    setTicked((x) => (x.some((id) => items.find((i) => i.id === id)?.status !== "proposed") ? x.filter((id) => items.find((i) => i.id === id)?.status === "proposed") : x));
  }, [items]);
  const allOn = list.length > 0 && live.length === list.length;
  const toggle = (id: string) => setTicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const run = async (op: PileOp, ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await api.bulkItems(ids, op);
      // Only the ones that went lose their tick: the rest (over the agent limit, busy, moved on) stay ticked to retry.
      const went = new Set(r.handled ?? []);
      setTicked((x) => x.filter((id) => !went.has(id)));
      setMsg(`${OPS.find((o) => o.op === op)!.label}: ${r.count}${r.skipped ? ` · ${r.skipped} left alone and still ticked (an agent's on it, it moved off Proposed, or over the ${PILE_AGENT_MAX}-agent limit)` : ""}`);
    } catch (e) {
      setMsg(`Couldn't: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const chip = (on: boolean, label: string, n: number | undefined, onClick: () => void, title?: string) => (
    <button key={label} className={`lane-tab ${on ? "on" : ""}`} onClick={onClick} title={title}>{label} <span className="n">{n ?? 0}</span></button>
  );
  return (
    <div className="pile">
      <div className="panel pile-head">
        <h2>Sort the pile</h2>
        <p>
          <b>{counts.total}</b> things sit on Proposed. Nothing here is committed and nothing happens to them on its own.
          Tick some, then drop what you won't do and commit, hand off or keep the rest. Oldest first: they're the easiest to drop.
        </p>
        <div className="pile-filters">
          <span className="pile-label">Age</span>
          {chip(!age, "All", counts.total, () => setAge(undefined))}
          {PILE_AGES.map((a) => chip(age === a.id, a.label, counts.age.get(a.id), () => setAge(age === a.id ? undefined : a.id)))}
        </div>
        <div className="pile-filters">
          <span className="pile-label">From</span>
          {chip(!source, "All", counts.total, () => setSource(undefined))}
          {PILE_SOURCES.filter((s) => counts.source.get(s.id)).map((s) => chip(source === s.id, s.label, counts.source.get(s.id), () => setSource(source === s.id ? undefined : s.id), s.hint))}
        </div>
      </div>
      <div className="panel pile-bar">
        <button className={`pile-tick ${allOn ? "on" : ""}`} onClick={() => setTicked(allOn ? [] : list.map((i) => i.id))} aria-pressed={allOn} aria-label="Tick every row shown" title={allOn ? "Untick all" : "Tick every row shown"}>
          <span className="tick">✓</span>
        </button>
        <span className="pile-count">{live.length ? `${live.length} ticked` : `${list.length} shown`}</span>
        {OPS.map((o) => (
          <button key={o.op} className={`mini-opt ${o.tone ?? ""}`} disabled={!live.length || busy} title={pileOpText(o.op, live.length || 1)} onClick={() => run(o.op, live)}>
            {o.label}{live.length ? ` ${o.op === "agent" ? Math.min(live.length, PILE_AGENT_MAX) : live.length}` : ""}
          </button>
        ))}
        <input className="filter-in" placeholder="Filter…" aria-label="Filter the pile" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pile-msg" aria-live="polite">{msg}</div>
      <div className="panel pile-list">
        {list.map((i) => {
          const on = live.includes(i.id);
          const src = PILE_SOURCES.find((s) => s.id === pileSource(i))!;
          return (
            <div key={i.id} className={`pile-row ${on ? "on" : ""} ${selected === i.id ? "sel" : ""}`}>
              <button className="pile-tick" onClick={() => toggle(i.id)} aria-pressed={on} aria-label="Tick this row" title={on ? "Untick" : "Tick"}><span className="tick">✓</span></button>
              <button className="pile-title" onClick={() => onOpen(i.id)} title="Open the item">
                <Md inline className="" text={i.title} />
                <span className="meta">
                  <span className="tag">{pileDays(i, t)}d</span>
                  <span className="tag" title={src.hint}>{i.source.label ?? src.label}</span>
                  {KIND_LABEL[i.kind] && <span className="tag">{KIND_LABEL[i.kind]}</span>}
                  {i.project && <span className="tag proj">{i.project}</span>}
                </span>
              </button>
              <span className="quick">
                <button className="qbtn" disabled={busy} title={pileOpText("today", 1)} onClick={() => run("today", [i.id])}><Icon name="sun" /></button>
                <button className="qbtn" disabled={busy} title={pileOpText("agent", 1)} onClick={() => run("agent", [i.id])}><Icon name="bolt" /></button>
                <button className="qbtn bad" disabled={busy} title={pileOpText("drop", 1)} onClick={() => run("drop", [i.id])}><Icon name="x" /></button>
              </span>
            </div>
          );
        })}
        {!list.length && <div className="empty">{counts.total ? "Nothing matches these filters." : "The pile is empty. Nice."}</div>}
      </div>
    </div>
  );
}
