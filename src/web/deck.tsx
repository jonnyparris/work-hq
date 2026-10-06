// "Clear the deck": every open question at once, grouped by how much of you it
// needs. One-tap stuff first, hand-offs next, head-work last (and deferrable in bulk).

import { useMemo, useState } from "react";
import { type BulkOp, type BulkRequest, type DeckGroup, EFFORT_LABEL, GROUP_ORDER, GROUPS, deckGroup, deferTargets } from "../shared/batch.ts";
import type { Item, Question } from "../shared/types.ts";
import { api } from "./store.ts";
import { KIND_LABEL } from "./ui.tsx";

export function Deck({ questions, items, now, onFocus, onClose }: {
  questions: Question[];
  items: Item[];
  now: Date;
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const targets = useMemo(() => deferTargets(now), [now.toDateString()]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const groups = useMemo(() => {
    const m = new Map<DeckGroup, Question[]>();
    for (const q of questions) m.set(deckGroup(q), [...(m.get(deckGroup(q)) ?? []), q]);
    for (const qs of m.values()) qs.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => ({ g, qs: m.get(g)! }));
  }, [questions]);

  const count = (e: string) => groups.filter((x) => GROUPS[x.g].effort === e).reduce((n, x) => n + x.qs.length, 0);
  const think = groups.filter((x) => GROUPS[x.g].effort === "think" && x.g !== "day");

  const run = async (key: string, reqs: BulkRequest[]) => {
    if (busy) return;
    setBusy(key);
    try { for (const r of reqs) await api.bulk(r); }
    finally { setBusy(undefined); }
  };
  const bulk = (g: DeckGroup, op: BulkOp, t?: { at: string; label: string }) =>
    run(`${g}:${op}:${t?.at ?? ""}`, [{ group: g, op, until: t?.at, label: t && `${t.label} 09:30` }]);

  if (!questions.length) {
    return (
      <div className="focus calm deck">
        <div className="deck-top"><h2>Deck's clear.</h2><span className="spacer" /><button className="skip" onClick={onClose}>Back (b)</button></div>
      </div>
    );
  }

  return (
    <div className="focus deck">
      <div className="deck-top">
        <h2>Clear the deck</h2>
        <span className="deck-sum">
          {questions.length} open · <b className="e-quick">{count("quick")} one tap</b> · <b className="e-agent">{count("agent")} hand off</b> · <b className="e-think">{count("think")} need you</b>
        </span>
        <span className="spacer" />
        <button className="skip" onClick={onClose}>One at a time (b)</button>
      </div>
      {think.length > 0 && (
        <div className="deck-eod">
          <span>Push everything that needs your head to</span>
          {targets.map((t) => (
            <button key={t.id} className="mini-opt" disabled={Boolean(busy)} onClick={() => run(`eod:${t.at}`, think.map((x) => ({ group: x.g, op: "defer" as const, until: t.at, label: `${t.label} 09:30` })))}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="deck-groups">
        {groups.map(({ g, qs }) => {
          const info = GROUPS[g];
          const ops = Object.entries(info.ops) as Array<[BulkOp, string]>;
          return (
            <section key={g} className={`deck-group e-${info.effort}`}>
              <div className="deck-gh">
                <h3>{info.label}</h3>
                <span className="tag">{EFFORT_LABEL[info.effort]}</span>
                <span className="count">{qs.length}</span>
                <span className="spacer" />
                {ops.filter(([op]) => op !== "defer").map(([op, label]) => (
                  <button key={op} className={`mini-opt ${op === "drop" ? "danger" : op === "dispatch" ? "primary" : ""}`} disabled={Boolean(busy)} onClick={() => bulk(g, op)}>
                    {busy === `${g}:${op}:` ? "…" : label}
                  </button>
                ))}
                {info.ops.defer && (
                  <span className="defer-set">
                    <span>{info.ops.defer} →</span>
                    {targets.map((t) => (
                      <button key={t.id} className="mini-opt quiet" disabled={Boolean(busy)} onClick={() => bulk(g, "defer", t)}>{t.label.replace("Tomorrow · ", "Tmrw ").replace("Next week · ", "")}</button>
                    ))}
                  </span>
                )}
              </div>
              {qs.map((q) => <DeckRow key={q.id} q={q} item={q.itemId ? byId.get(q.itemId) : undefined} targets={targets} onFocus={() => onFocus(q.id)} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function DeckRow({ q, item, targets, onFocus }: { q: Question; item?: Item; targets: ReturnType<typeof deferTargets>; onFocus: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch { setBusy(false); }
  };
  const special = q.kind === "plan" || q.kind === "wrap";
  // "Scheduled for…" needs words — that's the focus card's job.
  const opts = special ? [] : q.options.filter((o) => o.effect.type !== "when");
  return (
    <div className={`deck-row ${busy ? "busy" : ""}`}>
      <button className="deck-prompt" onClick={onFocus} title="Answer in the focus card">
        {item && <span className="tag">{KIND_LABEL[item.kind]}{item.project ? ` · ${item.project}` : ""}</span>}
        <span>{q.prompt}</span>
      </button>
      <span className="deck-opts">
        {special && <button className="mini-opt primary" onClick={onFocus}>Open</button>}
        {opts.map((o) => (
          <button key={o.id} className={`mini-opt ${o.tone ?? ""}`} disabled={busy} onClick={() => go(() => api.answer(q.id, o.id))}>{o.label}</button>
        ))}
        {!special && (
          <select className="mini-sel" value="" disabled={busy} onChange={(e) => {
            const t = targets.find((x) => x.id === e.target.value);
            if (t) go(() => api.bulk({ ids: [q.id], op: "defer", until: t.at, label: `${t.label} 09:30` }));
          }}>
            <option value="">Defer…</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
      </span>
    </div>
  );
}
