// "Clear the deck": every open question at once, grouped by how much of you it
// needs. One-tap stuff first, hand-offs next, head-work last (and deferrable in bulk).

import { useMemo, useState } from "react";
import {
  type BulkOp, type BulkRequest, type DeckGroup, type DeferTarget, EFFORT_LABEL, GROUP_ORDER, GROUPS, type SlotLoad, deckGroup, deferTargets, slotLine, slotLoad,
} from "../shared/batch.ts";
import type { CalendarEvent, Item, Question } from "../shared/types.ts";
import { api } from "./store.ts";
import { KIND_LABEL } from "./ui.tsx";

const short = (t: DeferTarget) => t.label.replace("Tomorrow · ", "").replace("Next week · ", "");

/** A batch defer waiting for a second look at the slot it lands in. */
interface PendingDefer {
  key: string;
  target: DeferTarget;
  groups: DeckGroup[];
  n: number;
}

export function Deck({ questions, allQuestions, items, events, calendarThrough, workHours, now, onFocus, onClose }: {
  questions: Question[];
  /** Every open question, snoozed ones too: they count toward a slot's load. */
  allQuestions?: Question[];
  items: Item[];
  events?: CalendarEvent[];
  calendarThrough?: string;
  workHours?: [number, number];
  now: Date;
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const [pending, setPending] = useState<PendingDefer | undefined>();
  const targets = useMemo(() => deferTargets(now), [now.toDateString()]);
  const loads = useMemo(() => {
    const ctx = { items, questions: allQuestions ?? questions, events: events ?? [], calendarThrough, workHours };
    return new Map(targets.map((t) => [t.id, slotLoad(t.at, ctx)]));
  }, [targets, items, allQuestions, questions, events, calendarThrough, workHours]);
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
  const bulk = (g: DeckGroup, op: BulkOp) => run(`${g}:${op}:`, [{ group: g, op }]);
  const ask = (key: string, target: DeferTarget, gs: DeckGroup[]) =>
    setPending({ key, target, groups: gs, n: groups.filter((x) => gs.includes(x.g)).reduce((n, x) => n + x.qs.length, 0) });
  const confirm = async (p: PendingDefer, at: string, time: string) => {
    await run(p.key, p.groups.map((g) => ({ group: g, op: "defer" as const, until: at, label: `${p.target.label} ${time}` })));
    setPending(undefined);
  };

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
            <button key={t.id} className={`mini-opt ${pending?.key === `eod:${t.at}` ? "primary" : ""}`} disabled={Boolean(busy)} title={slotLine(`${short(t)} 09:30`, loads.get(t.id)!)} onClick={() => ask(`eod:${t.at}`, t, think.map((x) => x.g))}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {pending && <DeferConfirm p={pending} load={loads.get(pending.target.id)!} busy={Boolean(busy)} onGo={(at, time) => confirm(pending, at, time)} onCancel={() => setPending(undefined)} />}
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
                      <button key={t.id} className={`mini-opt ${pending?.key === `${g}:defer:${t.at}` ? "primary" : "quiet"}`} disabled={Boolean(busy)} title={slotLine(`${short(t)} 09:30`, loads.get(t.id)!)} onClick={() => ask(`${g}:defer:${t.at}`, t, [g])}>{t.label.replace("Tomorrow · ", "Tmrw ").replace("Next week · ", "")}</button>
                    ))}
                  </span>
                )}
              </div>
              {qs.map((q) => <DeckRow key={q.id} q={q} item={q.itemId ? byId.get(q.itemId) : undefined} targets={targets} loads={loads} onFocus={() => onFocus(q.id)} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** The two facts worth seeing before a pile moves: what's already there, and what's on the calendar. */
function DeferConfirm({ p, load, busy, onGo, onCancel }: { p: PendingDefer; load: SlotLoad; busy: boolean; onGo: (at: string, time: string) => void; onCancel: () => void }) {
  const day = short(p.target);
  const warn = load.count > 0 || load.clashes.length > 0;
  return (
    <div className={`deck-confirm ${warn ? "warn" : ""}`}>
      <span className="deck-confirm-q">Defer {p.n} to {day} 09:30?</span>
      <span className="deck-confirm-load">{slotLine(`${day} 09:30`, load)}</span>
      <span className="spacer" />
      <button className="mini-opt primary" disabled={busy} onClick={() => onGo(p.target.at, "09:30")}>{busy ? "…" : `${day} 09:30`}</button>
      {load.nextFree && <button className="mini-opt good" disabled={busy} onClick={() => onGo(load.nextFree!.at, load.nextFree!.hhmm)}>{day} {load.nextFree.hhmm} — next free</button>}
      <button className="mini-opt quiet" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}

function DeckRow({ q, item, targets, loads, onFocus }: { q: Question; item?: Item; targets: DeferTarget[]; loads: Map<string, SlotLoad>; onFocus: () => void }) {
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
            {targets.map((t) => {
              const l = loads.get(t.id);
              const note = [l?.count ? `${l.count} there` : "", l?.clashes.length ? "clash" : ""].filter(Boolean).join(", ");
              return <option key={t.id} value={t.id}>{t.label}{note ? ` (${note})` : ""}</option>;
            })}
          </select>
        )}
      </span>
    </div>
  );
}
