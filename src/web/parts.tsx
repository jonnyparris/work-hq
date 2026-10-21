import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, Coaching, CoachOutcome, Item, ItemStatus, Job, JournalEntry, Question, SyncState } from "../shared/types.ts";
import { explainKey } from "../shared/detail.ts";
import { committedView } from "../shared/committed.ts";
import { type PlanGroup, planView, score, searchPlan } from "../shared/plan.ts";
import { CalmScene } from "./calm.tsx";
import { api } from "./store.ts";
import { ACTIONS, Icon, KIND_LABEL, Md, Q_BADGE, ago, dictateInto, finishDictation, hhmm, people, shortUrl, stopDictation, ticketKeys, ticketUrl, useStoredFlag, whenLabel } from "./ui.tsx";

// ── Now + timeline ────────────────────────────────────────────────────────
export function NowPanel({ now, events, workHours }: { now: Date; events: CalendarEvent[]; workHours: [number, number] }) {
  const [a, b] = workHours;
  const h = now.getHours() + now.getMinutes() / 60;
  const pct = Math.max(0, Math.min(100, ((h - a) / (b - a)) * 100));
  const upcoming = events.filter((e) => e.response !== "declined" && Date.parse(e.start) > now.getTime()).sort((x, y) => x.start.localeCompare(y.start));
  // Prefer a real meeting over a solo hold ("🚫 No interviews").
  const next = upcoming.find((e) => people(e.attendees).length > 0) ?? upcoming[0];
  const live = events.find((e) => Date.parse(e.start) <= now.getTime() && Date.parse(e.end) > now.getTime() && e.response !== "declined");
  const mins = next ? Math.round((Date.parse(next.start) - now.getTime()) / 60000) : 0;
  return (
    <div className="panel">
      <div className="now-big">{now.toTimeString().slice(0, 5)}</div>
      <div className="now-sub">{now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
      <div className="dayline"><i style={{ width: `${pct}%` }} /></div>
      <div className="dayline-l"><span>{a}:00</span><span>{Math.round(pct)}% of the day</span><span>{b}:00</span></div>
      {live && (
        <div className="next" style={{ background: "var(--sky-soft)", borderColor: "rgba(124,196,255,0.3)" }}>
          <small style={{ color: "var(--sky)" }}>Now · until {hhmm(live.end)}</small>
          <div>{live.title}</div>
        </div>
      )}
      {next && !live && (
        <div className="next">
          <small>Next · {mins < 60 ? `in ${mins} min` : hhmm(next.start)}</small>
          <div>{next.title}</div>
        </div>
      )}
    </div>
  );
}

export function Timeline({ now, events, items, onRefresh, sync }: { now: Date; events: CalendarEvent[]; items: Item[]; onRefresh: () => void; sync?: SyncState }) {
  const slots = items.filter((i) => i.status === "scheduled" && i.scheduledFor && new Date(i.scheduledFor).toDateString() === now.toDateString());
  const rows = [
    ...events.map((e) => ({ t: e.start, e })),
    ...slots.map((i) => ({ t: i.scheduledFor!, i })),
  ].sort((x, y) => x.t.localeCompare(y.t));
  let nowPlaced = false;
  return (
    <div className="panel">
      <div className="panel-h">
        <h3>Today</h3>
        <span className="count">{events.length}</span>
        <button className="act" onClick={onRefresh} title={sync?.error ?? `calendar ${ago(sync?.lastOkAt)}`}>↻</button>
      </div>
      {!rows.length && <div className="empty">{sync?.lastOkAt ? "Nothing on the calendar." : "Calendar not read yet — ↻ to fetch."}</div>}
      <div className="timeline">
        {rows.map((r, idx) => {
          const before = !nowPlaced && Date.parse(r.t) > now.getTime();
          if (before) nowPlaced = true;
          const line = before ? <div className="nowline" key={`now${idx}`} /> : null;
          if ("e" in r && r.e) {
            const e = r.e;
            const past = Date.parse(e.end) < now.getTime();
            const live = !past && Date.parse(e.start) <= now.getTime();
            return [line,
              <div key={e.id} className={`ev ${past ? "past" : ""} ${live ? "live" : ""} ${e.response === "declined" ? "declined" : ""}`}>
                <time>{hhmm(e.start)}</time>
                <div>
                  <div className="t">{e.url ? <a href={e.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{e.title}</a> : e.title}</div>
                  {people(e.attendees).length ? <div className="a">{people(e.attendees).slice(0, 4).join(", ")}{people(e.attendees).length > 4 ? ` +${people(e.attendees).length - 4}` : ""}</div> : null}
                </div>
              </div>];
          }
          const i = (r as any).i as Item;
          return [line,
            <div key={i.id} className="ev slot">
              <time>{hhmm(i.scheduledFor!)}</time>
              <div className="t">↳ {i.title}</div>
            </div>];
        })}
        {!nowPlaced && rows.length > 0 && <div className="nowline" />}
      </div>
    </div>
  );
}

// ── Focus: the one question ───────────────────────────────────────────────
export function Focus({ q, total, fresh = 0, nav = 0, onHold, items, onSkip, onBack, canBack, onOpenItem }: { q?: Question; total: number; fresh?: number; nav?: number; onHold?: (hold: boolean) => void; items: Item[]; onSkip: () => void; onBack?: () => void; canBack?: boolean; onOpenItem: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [noteFocus, setNoteFocus] = useState(false);
  // Set when you answer or send: the card leaving is expected, so the note goes with it.
  const leaving = useRef(false);
  // The card you were writing on closed elsewhere: the note stays, flagged, rather than vanishing.
  const [carried, setCarried] = useState(false);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  // "Scheduled for…": the option id waiting for the owner to say when.
  const [whenFor, setWhenFor] = useState<string | undefined>();
  const [heard, setHeard] = useState(false);
  const [phase, setPhase] = useState<string>("idle");
  useEffect(() => {
    const on = (e: Event) => setPhase((e as CustomEvent).detail);
    window.addEventListener("whq:dictate-phase", on);
    return () => window.removeEventListener("whq:dictate-phase", on);
  }, []);
  const whenRef = useRef<HTMLInputElement>(null);
  const typed = useRef(false);
  // Never wipe words you didn't send. The note clears on answer, send, skip or back — not just because
  // the card in front changed.
  const noteNow = useRef(note);
  noteNow.current = note;
  useEffect(() => {
    setBusy(false); setWhenFor(undefined);
    // The input remounts with the card (key={q.id}), so it can't still have focus; onBlur doesn't fire on unmount.
    setNoteFocus(false);
    if (leaving.current || !noteNow.current.trim()) { setNote(""); setCarried(false); }
    else setCarried(true);
    leaving.current = false;
  }, [q?.id]);
  useEffect(() => { if (nav) { setNote(""); setCarried(false); } }, [nav]);
  useEffect(() => { onHold?.(noteFocus || Boolean(note.trim()) || Boolean(whenFor) || phase !== "idle"); }, [noteFocus, note, whenFor, phase, onHold]);
  useEffect(() => () => onHold?.(false), [onHold]);
  // Never leave the mic open behind a question that's gone.
  const whenOpen = useRef(false);
  whenOpen.current = Boolean(whenFor);
  useEffect(() => () => { if (whenOpen.current) stopDictation(); }, [q?.id]);

  const answer = async (optionId: string, itemIds?: string[], words?: string) => {
    if (!q || busy) return;
    const o = q.options.find((x) => x.id === optionId);
    const text = (words ?? note).trim();
    if (o?.effect.type === "when" && !text) return startWhen(optionId);
    // Typed or ⌘↵ submit while still dictating: release the mic now, drop the late final result.
    if (whenFor) { stopDictation(); setHeard(false); }
    setBusy(true);
    leaving.current = true;
    try { await api.answer(q.id, optionId, text || undefined, itemIds ?? (q.kind === "plan" ? picked : undefined)); }
    catch { leaving.current = false; setBusy(false); }
  };

  const startWhen = (optionId: string) => {
    setWhenFor(optionId);
    setNote("");
    typed.current = false;
    setHeard(true);
    setTimeout(() => whenRef.current?.focus(), 0);
    dictateInto((t, final) => {
      if (typed.current) return;
      setNote(t);
      if (final) {
        setHeard(false);
        // Spoken answers go straight through: that's the point.
        if (t.trim()) answer(optionId, undefined, t);
      }
    });
  };
  const cancelWhen = () => { stopDictation(); setWhenFor(undefined); setHeard(false); setNote(""); };

  // ⌘↵ in the note: the note is the answer. The server reads it and acts (pick an option, set status,
  // schedule, send an agent); pure context parks the question till the next working morning.
  // Either way it leaves the queue now and doesn't bounce straight back.
  const [noteErr, setNoteErr] = useState<string | undefined>();
  useEffect(() => setNoteErr(undefined), [q?.id]);
  const saveNote = async () => {
    const text = note.trim();
    if (!q || busy || !text) return;
    setBusy(true);
    setNoteErr(undefined);
    leaving.current = true;
    try {
      await api.note(q.id, text);
      setNote("");
      noteRef.current?.blur();
    } catch (e) {
      leaving.current = false;
      setNoteErr((e as Error).message);
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!q || whenFor || (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length) { e.preventDefault(); answer(q.options[n - 1]!.id); }
      else if (e.key === "s" || e.key === "ArrowRight") { e.preventDefault(); onSkip(); }
      else if (e.key === "ArrowLeft" && canBack) { e.preventDefault(); onBack?.(); }
      else if (e.key === "n") { e.preventDefault(); noteRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!q) {
    return (
      <div className="focus calm allclear">
        <CalmScene />
        <div className="big">Nothing needs you right now.</div>
        <p>I'll ask when something's due, a meeting ends, or a capture lands. Say 🍍 or type below any time.</p>
      </div>
    );
  }
  const [defBadge, tone] = Q_BADGE[q.kind];
  const badge = q.badge ?? defBadge;
  const item = q.itemId ? items.find((i) => i.id === q.itemId) : undefined;
  return (
    <div className="focus" key={q.id}>
      <div className="focus-top">
        <span className={`badge ${tone}`}>{badge}</span>
        {item && (
          <button className="tag" onClick={() => onOpenItem(item.id)} title="Open item">
            {KIND_LABEL[item.kind]}{item.project ? ` · ${item.project}` : ""} ↗
          </button>
        )}
        {fresh > 0 && <span className="badge sky" title="Arrived while you were writing. They'll come up when you're done with this card.">+{fresh} new</span>}
        <span className="focus-count">1 of {total}</span>
      </div>
      <h1><Md inline className="" text={q.prompt} /></h1>
      {q.context && <Md className="ctx md" text={q.context} />}
      {item?.notes?.some((n) => !(n.who === "hq" && q.context?.includes(n.text))) ? (
        <div className="ctx prior-notes" title="What you said about this before">
          {item.notes.filter((n) => !(n.who === "hq" && q.context?.includes(n.text))).slice(-2).map((n, i) => <div key={`${n.at}-${i}`}>{n.who === "hq" ? "↳ HQ" : "✎"} <span className="when">{relDay(n.at)}</span> {n.text}</div>)}
        </div>
      ) : null}
      {q.kind === "plan" && <Planner items={items} picked={picked} setPicked={setPicked} />}
      {q.kind === "wrap" && <Wrap items={items} />}
      {whenFor ? (
        <div className="when-say">
          <div className="when-prompt">{heard && phase === "transcribing" ? <><span className="thinking"><i /><i /><i /></span> Transcribing…</> : heard ? <><span className="rec-dot" /> Listening — say when. <kbd>↵</kbd> when done</> : "When?"} <span>“booked it Thu 2pm” · “put it in Friday morning” · “remind me Monday”</span></div>
          <div className="when-row">
            <input
              ref={whenRef}
              className="note-in"
              value={note}
              placeholder="…or type it"
              onChange={(e) => { typed.current = true; stopDictation(); setHeard(false); setNote(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) answer(whenFor, undefined, note);
                // Still talking, nothing typed: ↵ / ⌘↵ means "that's it" — stop the mic, send what was heard.
                else if (e.key === "Enter" && heard) { e.preventDefault(); finishDictation(); }
                if (e.key === "Escape") cancelWhen();
              }}
            />
            <button className="opt primary" disabled={!note.trim() || busy} onClick={() => answer(whenFor, undefined, note)}>Set</button>
            <button className="skip" onClick={cancelWhen}>Cancel</button>
          </div>
        </div>
      ) : (
      <div className="options">
        {q.options.map((o, i) => (
          <button key={o.id} className={`opt ${o.tone ?? ""}`} disabled={busy} onClick={() => answer(o.id)}>
            <kbd>{i + 1}</kbd>{q.kind === "plan" && o.id === "plan" ? (picked.length ? `Commit to ${picked.length}` : "Clear today") : o.label}
          </button>
        ))}
      </div>
      )}
      <div className="focus-foot">
        {canBack && <button className="skip" onClick={onBack} title="Previous card (←)">← Back</button>}
        <input
          ref={noteRef}
          className="note-in"
          value={note}
          onChange={(e) => { setNote(e.target.value); setCarried(false); }}
          onFocus={() => setNoteFocus(true)}
          onBlur={() => setNoteFocus(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(); }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          placeholder={q.kind === "review" ? "What came out of it? (goes to triage)  ⌘↵ send" : "Tell me what to do, or correct me — I'll act on it  (n · ⌘↵)"}
        />
        {note.trim() && <button className="skip send" disabled={busy} onClick={saveNote}>Send ⌘↵</button>}
        <button className="skip" onClick={onSkip} title="Next card, nothing changes (s or →)">Next →</button>
      </div>
      {carried && note.trim() && <div className="ctx" style={{ color: "var(--text-2)" }}>The card you were writing on closed elsewhere. Your note is kept — ⌘↵ sends it to this card, or clear it.</div>}
      {noteErr && <div className="ctx" style={{ color: "var(--coral)" }}>Couldn't send: {noteErr}</div>}
    </div>
  );
}

function relDay(iso: string) {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  const t = d.toTimeString().slice(0, 5);
  return days === 0 ? t : days === 1 ? `yesterday ${t}` : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Morning plan: at most three suggested and pre-ticked, with a reason each (src/shared/plan.ts). Picks sit on top,
 * the rest below by group. The list follows the live items. Typing filters every open item; ↵ on no match adds
 * it as a task. Unticked items on today go back to the backlog when you commit.
 */
function Planner({ items, picked, setPicked }: { items: Item[]; picked: string[]; setPicked: (x: string[]) => void }) {
  const view = useMemo(() => planView(items), [items]);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    setPicked(view.suggested);
  }, [view]);
  // A pick that got closed or handed to an agent elsewhere drops out.
  useEffect(() => {
    const keep = picked.filter((id) => { const it = items.find((i) => i.id === id); return it && !["done", "dropped", "doing"].includes(it.status); });
    if (keep.length !== picked.length) setPicked(keep);
  }, [items]);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const byId = new Map(view.rows.map((r) => [r.item.id, r]));
  const results = q.trim() ? searchPlan(items, q) : [];
  const add = async () => {
    const title = q.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      const it = await api.add(title, "proposed") as Item;
      setPicked([...picked, it.id]);
      setQ("");
    } finally { setAdding(false); }
  };
  const row = (i: Item, why?: string, suggested?: boolean) => (
    <button key={i.id} className={`pick-row ${picked.includes(i.id) ? "on" : ""}`} onClick={() => toggle(i.id)}>
      <span className="tick">✓</span>
      <span style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5 }}>{i.title}</div>
        <div className="meta">
          {suggested && <span className="tag suggest">suggested</span>}
          {why && <span className="why-tag">{why}</span>}
          {i.project && <span className="tag proj">{i.project}</span>}
          {!["today", "proposed", "inbox"].includes(i.status) && <span className="tag">{i.status}</span>}
        </div>
      </span>
      <span className="tag">{KIND_LABEL[i.kind]}</span>
    </button>
  );
  const pickedItems = picked.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => Boolean(i));
  const groups: Array<[PlanGroup, string]> = [["today", "Already on today"], ["due", "Due or scheduled"], ["backlog", "From the backlog"]];
  const todayLeft = view.rows.filter((r) => r.group === "today" && !picked.includes(r.item.id)).length;
  return (
    <div className="planner">
      <div className="plan-search">
        <input
          ref={inputRef}
          className="note-in"
          value={q}
          placeholder="Find anything open, or type a new task and press ↵"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Enter" && q.trim()) { e.preventDefault(); if (results.length === 1 && !picked.includes(results[0]!.id)) { toggle(results[0]!.id); setQ(""); } else if (!results.length) add(); }
          }}
        />
      </div>
      <div className="pick">
        {q.trim() ? (
          <>
            {results.map((i) => row(i, byId.get(i.id)?.why))}
            <button className="pick-row add-row" disabled={adding} onClick={add}>
              <span className="tick">+</span>
              <span>Add “{q.trim()}” as a task for today{!results.length && <kbd style={{ marginLeft: 8 }}>↵</kbd>}</span>
              <span />
            </button>
          </>
        ) : (
          <>
            <div className="pick-h">Today's picks <span>{pickedItems.length}{pickedItems.length > 3 ? " · three's the point" : ""}</span></div>
            {pickedItems.length ? pickedItems.map((i) => row(i, byId.get(i.id)?.why, view.suggested.includes(i.id))) : <div className="pick-empty">Nothing picked. Tick something below, or type a task above.</div>}
            {groups.map(([g, label]) => {
              const rs = view.rows.filter((r) => r.group === g && !picked.includes(r.item.id));
              return rs.length ? (
                <div key={g}>
                  <div className="pick-h">{label}</div>
                  {rs.map((r) => row(r.item, r.why))}
                </div>
              ) : null;
            })}
          </>
        )}
      </div>
      <div className="pick-foot">
        {todayLeft > 0 && <span>{todayLeft} unticked on today go back to the backlog.</span>}
        {view.withAgents > 0 && <span>{view.withAgents} with agents, not shown.</span>}
        {view.hiddenIdeas > 0 && <span>{view.hiddenIdeas} agent ideas hidden. Search finds them.</span>}
      </div>
    </div>
  );
}

function Wrap({ items }: { items: Item[] }) {
  const todayStr = new Date().toDateString();
  const rows = items.filter(
    (i) => ["today", "doing"].includes(i.status) || (i.confirmedAt && new Date(i.confirmedAt).toDateString() === todayStr && i.status !== "dropped"),
  );
  if (!rows.length) return <div className="empty" style={{ marginTop: 12 }}>Nothing was committed today. Honest answer — save it anyway.</div>;
  const set = (i: Item, s: "done" | "carry" | "waiting" | "dropped") => {
    if (s === "carry") {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(9, 30, 0, 0);
      return api.schedule(i.id, t.toISOString(), "tomorrow 09:30 (carried)");
    }
    return api.setStatus(i.id, s as ItemStatus);
  };
  return (
    <div className="pick">
      {rows.map((i) => (
        <div key={i.id} className="pick-row" style={{ gridTemplateColumns: "1fr auto" }}>
          <Md inline className="" text={i.title} />
          <span className="seg">
            <button className={`${i.status === "done" ? "on done" : ""}`} onClick={() => set(i, "done")}>Done</button>
            <button className={`${i.status === "scheduled" ? "on" : ""}`} onClick={() => set(i, "carry")}>Carry</button>
            <button className={`${i.status === "waiting" ? "on wait" : ""}`} onClick={() => set(i, "waiting")}>Waiting</button>
            <button className={`${i.status === "dropped" ? "on drop" : ""}`} onClick={() => set(i, "dropped")}>Drop</button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Items ─────────────────────────────────────────────────────────────────
export function ItemRow({ it, onOpen, selected, compact }: { it: Item; onOpen: () => void; selected?: boolean; compact?: boolean }) {
  const now = new Date();
  const stop = (fn: () => unknown) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div className={`item k-${it.kind} ${it.status} ${selected ? "sel" : ""}`} onClick={onOpen}>
      {compact ? (
        <button className="check" onClick={stop(() => api.setStatus(it.id, it.status === "done" ? "today" : "done"))}>✓</button>
      ) : (
        <span className="glyph"><Icon name={it.kind} /></span>
      )}
      <div style={{ minWidth: 0 }}>
        <div className="title"><Md inline className="" text={it.title} /></div>
        <div className="meta">
          {it.project && <span className="tag proj">{it.project}</span>}
          {it.scheduledFor && it.status === "scheduled" && <span className="tag when">⏱ {whenLabel(it.scheduledFor, now)}</span>}
          {it.when && it.status !== "scheduled" && <span className="tag when">{it.when}</span>}
          {it.signals?.pineapple && <span className="tag src-pineapple">🍍</span>}
          {it.source.type !== "memory" && !compact && <span className={`tag src-${it.source.type}`}>{it.source.label ?? it.source.type}</span>}
          {it.signals?.killDate && !["done", "dropped"].includes(it.status) && <span className="tag warn">kill {it.signals.killDate.slice(5)}</span>}
          {it.signals?.stateUnknown && !it.confirmedAt && !compact && <span className="tag">state?</span>}
          {it.status === "doing" && <span className="tag src-agent">🛰 in progress</span>}
          {it.links?.slice(0, 2).map((l) => (
            <a key={l} className="tag" href={l} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{shortUrl(l)}</a>
          ))}
        </div>
      </div>
      <div className="quick">
        {!compact && it.status !== "today" && <button className="qbtn" title="Today" onClick={stop(() => api.setStatus(it.id, "today"))}><Icon name="sun" /></button>}
        {!compact && <button className="qbtn good" title="Done" onClick={stop(() => api.setStatus(it.id, "done"))}><Icon name="check" /></button>}
        <button className="qbtn" title="Waiting" onClick={stop(() => api.setStatus(it.id, "waiting"))}><Icon name="wait" /></button>
        <button className="qbtn bad" title="Drop" onClick={stop(() => api.setStatus(it.id, "dropped"))}><Icon name="x" /></button>
      </div>
    </div>
  );
}

const LANES: Array<{ id: string; label: string; test: (i: Item) => boolean }> = [
  { id: "inbox", label: "Captured", test: (i) => i.status === "inbox" },
  { id: "proposed", label: "Proposed", test: (i) => i.status === "proposed" },
  { id: "scheduled", label: "Scheduled", test: (i) => i.status === "scheduled" },
  { id: "waiting", label: "Waiting", test: (i) => i.status === "waiting" },
  { id: "done", label: "Closed", test: (i) => i.status === "done" || i.status === "dropped" },
];

export function Board({ items, selected, onOpen }: { items: Item[]; selected?: string; onOpen: (id: string) => void }) {
  const [lane, setLane] = useState<string>(() => (items.some((i) => i.status === "inbox") ? "inbox" : "proposed"));
  const [q, setQ] = useState("");
  // Folded by default: the tabs (with counts) stay as a one-line header; a tab or the chevron opens it.
  // Open/closed is remembered per browser (whq:open:lists), so a list you keep open stays open after a reload.
  const [open, setOpen] = useStoredFlag("whq:open:lists", false);
  const L = LANES.find((l) => l.id === lane)!;
  const list = items
    .filter(L.test)
    .filter((i) => !q || `${i.title} ${i.project ?? ""} ${i.detail ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (lane === "scheduled" ? (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "") : score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt)));
  return (
    <div className={`panel board ${open ? "" : "folded"}`}>
      <div className="lanes-h">
        <FoldToggle open={open} onToggle={() => setOpen((x) => !x)} label="lists" />
        {LANES.map((l) => (
          <button key={l.id} className={`lane-tab ${open && lane === l.id ? "on" : ""}`} onClick={() => { setLane(l.id); setOpen(true); }}>
            {l.label} <span className="n">{items.filter(l.test).length}</span>
          </button>
        ))}
        {open && <input className="filter-in" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {open && (
        <div className="items">
          {list.map((i) => <ItemRow key={i.id} it={i} selected={selected === i.id} onOpen={() => onOpen(i.id)} />)}
          {!list.length && <div className="empty">{lane === "inbox" ? "No fresh captures. Transcripts and 🍍 land here." : "Nothing here."}</div>}
        </div>
      )}
    </div>
  );
}

export function TodayPanel({ items, jobs = [], onOpen, selected }: { items: Item[]; jobs?: Job[]; onOpen: (id: string) => void; selected?: string }) {
  // Your open items + the last couple of hours' closures (src/shared/committed.ts); agent-run work is in Agents.
  const { rows: list, open: openCount, doneToday, withAgents } = committedView(items, jobs);
  const [adding, setAdding] = useState("");
  // Folded by default to a one-line header with the count; click it to see the list and the add box.
  // Open/closed is remembered per browser (whq:open:committed).
  const [open, setOpen] = useStoredFlag("whq:open:committed", false);
  return (
    <div className={`panel today ${open ? "" : "folded"}`}>
      <button className="panel-h fold-h" aria-expanded={open} onClick={() => setOpen((x) => !x)} title={open ? "Collapse" : "Show commitments"}>
        <Chev open={open} />
        <h3>Committed</h3>
        <span className="count" title="Open items">{openCount}</span>
        {doneToday > 0 && <span className="act">{doneToday} done today</span>}
      </button>
      {open && (
        <>
          <div className="items">
            {list.map((i) => <ItemRow key={i.id} it={i} compact selected={selected === i.id} onOpen={() => onOpen(i.id)} />)}
            {!list.length && <div className="empty">Nothing committed yet. The morning plan fixes that.</div>}
          </div>
          {withAgents > 0 && <div className="empty" style={{ fontSize: 12 }}>{withAgents} more with agents: see Agents.</div>}
          <input
            className="note-in"
            style={{ marginTop: 10, width: "100%" }}
            placeholder="+ Add a commitment"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && adding.trim()) { api.add(adding.trim()); setAdding(""); } }}
          />
        </>
      )}
    </div>
  );
}

function Chev({ open }: { open: boolean }) {
  return (
    <svg className={`chev ${open ? "on" : ""}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Chevron that opens and closes a folded panel. */
export function FoldToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button className="fold-btn" aria-expanded={open} onClick={onToggle} title={open ? `Collapse ${label}` : `Show ${label}`}>
      <Chev open={open} />
    </button>
  );
}

// ── Coaching ──────────────────────────────────────────────────────────────
/** The nightly reflection's "one thing to try", so the tip doesn't depend on a briefing running. */
export function CoachingPanel({ c, now }: { c?: Coaching; now: Date }) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(false);
  if (!c) return null;
  const age = Math.round((now.getTime() - Date.parse(`${c.date}T12:00:00`)) / 86_400_000);
  const stale = age > 2;
  const tone = /^(strong|on track|good)/i.test(c.signal) ? "leaf" : /^(weak|below|off)/i.test(c.signal) ? "coral" : "violet";
  const lines = c.move.split("\n").filter((l) => l.trim());
  const first = lines.map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\*\*|`/g, "").trim()).find(Boolean) ?? "";
  return (
    <div className="panel coaching">
      <div className="panel-h">
        <h3>One thing to try</h3>
        {c.signal && <span className={`badge ${tone}`} title="This week's M5 signal, from the nightly reflection">{c.signal}</span>}
        <a className="act" href={c.url} title={c.file}>{stale ? <span style={{ color: "var(--coral)" }}>{c.date.slice(5)} · stale</span> : c.date.slice(5)}</a>
      </div>
      {c.when && <div className="coach-when">{c.when}</div>}
      <div className="coach-move">
        {lines.map((l, i) => {
          const depth = Math.min(3, Math.floor((/^\s*/.exec(l)![0].length) / 2));
          const num = /^\s*(\d+)\.\s+/.exec(l)?.[1];
          const text = l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
          return (
            <div key={i} className="coach-line" style={{ paddingLeft: depth * 14 }}>
              <span className="coach-mark">{num ? `${num}.` : /^\s*[-*]\s/.test(l) ? "•" : ""}</span>
              <Md text={text} inline />
            </div>
          );
        })}
      </div>
      <CoachTrack history={c.history ?? []} />
      <div className="coach-foot">
        {(c.wins.length > 0 || c.gaps.length > 0) && (
          <button className="kbd-btn" onClick={() => setOpen((x) => !x)}>{open ? "Hide" : "Why"} ({c.wins.length} wins · {c.gaps.length} gaps)</button>
        )}
        <span className="spacer" />
        <button className="kbd-btn" disabled={added || !first} title="Add it to Committed" onClick={() => { api.add(`M5: ${first}`.slice(0, 160)); setAdded(true); }}>
          {added ? "Committed ✓" : "+ Commit"}
        </button>
      </div>
      {open && (
        <div className="coach-why">
          {c.wins.length > 0 && <><div className="coach-h">Did well</div>{c.wins.map((w, i) => <div key={i} className="coach-line"><span className="coach-mark" style={{ color: "var(--leaf)" }}>+</span><Md text={w} inline /></div>)}</>}
          {c.gaps.length > 0 && <><div className="coach-h">Below M5</div>{c.gaps.map((w, i) => <div key={i} className="coach-line"><span className="coach-mark" style={{ color: "var(--coral)" }}>−</span><Md text={w} inline /></div>)}</>}
        </div>
      )}
    </div>
  );
}

const COACH_OUTCOME: Record<CoachOutcome["outcome"], { label: string; mark: string; color: string }> = {
  done: { label: "Done", mark: "✓", color: "var(--leaf)" },
  agent: { label: "Handed off", mark: "→", color: "var(--sky)" },
  not: { label: "Not today", mark: "✕", color: "var(--coral)" },
  missed: { label: "No answer", mark: "·", color: "var(--text-3)" },
};

/** Did the moves happen: the latest answer, and a dot per recent move (oldest left). */
export function CoachTrack({ history }: { history: CoachOutcome[] }) {
  if (!history.length) return null;
  const last = history[0]!;
  const o = COACH_OUTCOME[last.outcome];
  const done = history.filter((h) => h.outcome === "done").length;
  const handed = history.filter((h) => h.outcome === "agent" || h.via === "agent").length;
  const text = (h: CoachOutcome) => `${COACH_OUTCOME[h.outcome].label}${h.via === "agent" ? " (via agent)" : ""}`;
  return (
    <div className="coach-track">
      <span title={last.note ? `${text(last)} — ${last.note}` : undefined}>
        {last.date.slice(5)}: <b style={{ color: o.color }}>{text(last)}</b>
      </span>
      <span className="spacer" />
      <span className="coach-dots" aria-hidden>
        {[...history].reverse().map((h) => (
          <span key={h.date} title={`${h.date.slice(5)}: ${text(h)}${h.note ? ` — ${h.note}` : ""}`} style={{ color: COACH_OUTCOME[h.outcome].color }}>{COACH_OUTCOME[h.outcome].mark}</span>
        ))}
      </span>
      <span title={handed ? `${handed} handed to an agent` : undefined}>{history.length > 1 ? `${done} of last ${history.length} done` : done ? "done" : "not done"}</span>
    </div>
  );
}

// ── Agents ────────────────────────────────────────────────────────────────
export function AgentsPanel({ jobs, cmux }: { jobs: Job[]; cmux: boolean }) {
  const live = jobs.filter((j) => ["running", "blocked", "queued"].includes(j.status));
  const recent = jobs.filter((j) => !live.includes(j)).slice(0, 6);
  return (
    <div className="panel">
      <div className="panel-h">
        <h3>Agents</h3>
        {live.length > 0 && <span className="count" style={{ color: "var(--sky)" }}>{live.length} live</span>}
        <span className="act" title="Dispatched actions open as pi sessions in the cmux 'Work HQ' group">{cmux ? "cmux ✓" : "headless"}</span>
      </div>
      {!jobs.length && <div className="empty">No agents yet. Dispatch from any item or question.</div>}
      {[...live, ...recent].map((j) => <JobCard key={j.id} j={j} />)}
    </div>
  );
}

function JobCard({ j }: { j: Job }) {
  const dot = { queued: "run", running: "run", blocked: "run", done: "ok", failed: "err" }[j.status];
  return (
    <div className={`job ${j.status}`}>
      <div className="job-h">
        <span className={`dot ${dot}`} style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block" }} />
        <span className="name" title={j.title}>{j.title}</span>
        <span className="surface">{j.kind === "action" ? (j.surface === "cmux" ? "cmux" : "pi") : j.kind}</span>
      </div>
      {j.status === "blocked" && <div className="sum" style={{ color: "var(--gold)" }}>Waiting for you in cmux</div>}
      {["running", "queued"].includes(j.status) && j.tail.length > 0 && (
        <div className="tail">{j.tail.slice(-3).map((l, i) => <div key={i}>{l}</div>)}</div>
      )}
      {j.summary && !["running", "queued"].includes(j.status) && <div className="sum">{j.summary}</div>}
      {j.error && <div className="err">{j.error}</div>}
      <div className="job-acts">
        {j.workspace && <button className="mini" onClick={() => api.focusJob(j.id)}>Open in cmux ↗</button>}
        {["running", "queued", "blocked"].includes(j.status) && <button className="mini" onClick={() => api.cancelJob(j.id)}>Stop</button>}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>{ago(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
      </div>
    </div>
  );
}

// ── Journal ───────────────────────────────────────────────────────────────
export function JournalPanel({ journal, onAll, onOpenItem }: { journal: JournalEntry[]; onAll: () => void; onOpenItem?: (id: string) => void }) {
  const pending = journal.filter((j) => !j.synced).length;
  return (
    <div className="panel">
      <div className="panel-h">
        <h3>Journal</h3>
        {pending > 0 && <span className="count" title="Not yet written to memory" style={{ color: "var(--gold)" }}>{pending} unsaved</span>}
        <button className="act" onClick={onAll}>All →</button>
      </div>
      {journal.slice(0, 10).map((j) => <JRow key={j.id} j={j} onOpen={onOpenItem} />)}
      {!journal.length && <div className="empty">Every decision you make here is written down, then saved to memory.</div>}
    </div>
  );
}

/** A row tied to an item opens its drawer, so you can reopen or redispatch something closed by mistake. */
export function JRow({ j, onOpen }: { j: JournalEntry; onOpen?: (id: string) => void }) {
  const id = j.itemId;
  const link = id && onOpen
    ? {
        role: "button",
        tabIndex: 0,
        title: "Open item",
        onClick: () => onOpen(id),
        onKeyDown: (e: { key: string; preventDefault: () => void }) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(id); } },
      }
    : {};
  return (
    <div className={id && onOpen ? "jr link" : "jr"} {...link}>
      <time>{hhmm(j.at)}</time>
      <div className={`who-${j.who}`}>{j.text}{!j.synced && <span className="unsynced" title="Not in memory yet" />}</div>
    </div>
  );
}

export function JournalPage({ journal, journalPath, onOpenItem }: { journal: JournalEntry[]; journalPath?: string; onOpenItem?: (id: string) => void }) {
  const byDay = new Map<string, JournalEntry[]>();
  for (const j of journal) {
    const d = new Date(j.at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    byDay.set(d, [...(byDay.get(d) ?? []), j]);
  }
  return (
    <div className="journal-page">
      <div className="panel" style={{ marginBottom: 8 }}>
        <div className="md">
          Everything you decide, correct or dictate lands here first.{" "}
          {journalPath
            ? <>Every few minutes it's written to <code>{journalPath}</code> in memory, so your briefings and reflections read it before trusting anything that says “state unknown”.</>
            : <>Connect a memory server (<code>memory.url</code> in the config) and it's saved there too, for briefings and reflections to read.</>}
        </div>
      </div>
      {[...byDay.entries()].map(([d, list]) => (
        <div key={d}>
          <div className="day-h">{d}</div>
          {list.map((j) => <JRow key={j.id} j={j} onOpen={onOpenItem} />)}
        </div>
      ))}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────
/**
 * The context first: a plain-English read on demand ("Explain simply", no tools, a few seconds), the source
 * quote with where it came from, then the detail split for skimming (lead sentence + bullets, long ones folded).
 */
function WhySection({ it }: { it: Item }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => { setBusy(false); setErr(undefined); }, [it.id]);
  const ex = it.explain;
  const stale = Boolean(ex && ex.for !== explainKey(it));
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setErr(undefined);
    try { await api.explain(it.id); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="sec why">
      <div className="sec-h">
        <h4>Why this exists</h4>
        <button className="mini" disabled={busy} onClick={run} title="A short plain-English read of this item. Uses only what's written here.">
          {busy ? <><span className="thinking"><i /><i /><i /></span> Explaining…</> : ex ? (stale ? "Explain again (changed)" : "Explain again") : "Explain simply"}
        </button>
      </div>
      {ex && (
        <div className={`explain ${stale ? "stale" : ""}`}>
          <div className="explain-row"><b>What</b><Md inline className="md" text={ex.what} /></div>
          {ex.why && <div className="explain-row"><b>Why</b><Md inline className="md" text={ex.why} /></div>}
          {ex.done && <div className="explain-row"><b>Done</b><Md inline className="md" text={ex.done} /></div>}
          {ex.terms?.length ? (
            <dl className="terms">
              {ex.terms.map((t) => <div key={t.term}><dt>{t.term}</dt><dd>{t.meaning}</dd></div>)}
            </dl>
          ) : null}
          <div className="explain-foot">Plain-English read · {ago(ex.at)}{stale ? " · the item changed since" : ""}</div>
        </div>
      )}
      {err && <div className="ctx" style={{ color: "var(--coral)" }}>Couldn't explain: {err}</div>}
      {it.source.quote && (
        <blockquote className="quote-block">
          “{it.source.quote}”
          <cite>{it.source.label ?? it.source.type}</cite>
        </blockquote>
      )}
      {it.detail ? <Md skim collapseAfter={5} text={it.detail} /> : !it.source.quote && !ex && <div className="empty-why">No detail written down. “Explain simply” works from the title alone.</div>}
    </div>
  );
}

const STATUSES: ItemStatus[] = ["inbox", "proposed", "today", "scheduled", "doing", "waiting", "done", "dropped"];

export function Drawer({ it, journal, jobs, onClose }: { it: Item; journal: JournalEntry[]; jobs: Job[]; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [at, setAt] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest("textarea, input, h2") && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const history = journal.filter((j) => j.itemId === it.id);
  const itemJobs = jobs.filter((j) => j.itemId === it.id);
  const sendNote = async () => {
    if (!note.trim()) return;
    await api.patch(it.id, { note: note.trim() });
    setNote("");
  };
  const quick = (label: string, d: Date) => (
    <button className="st" onClick={() => api.schedule(it.id, d.toISOString(), label)}>{label}</button>
  );
  const t = (h: number, m: number, plus = 0) => { const d = new Date(); d.setDate(d.getDate() + plus); d.setHours(h, m, 0, 0); return d; };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="row">
            <span className={`badge ${it.status === "done" ? "leaf" : it.status === "dropped" ? "coral" : "quiet"}`}>{it.status}</span>
            <select
              className="tag"
              value={it.kind}
              onChange={(e) => api.patch(it.id, { kind: e.target.value })}
              style={{ background: "var(--surface-2)", border: 0, color: "var(--text-2)" }}
              title="Correct the kind"
            >
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {it.project && <span className="tag proj">{it.project}</span>}
            <span className="spacer" />
            <button className="qbtn" onClick={onClose}><Icon name="x" /></button>
          </div>
          <h2
            ref={titleRef}
            contentEditable
            suppressContentEditableWarning
            onBlur={(e) => { const v = e.currentTarget.textContent?.trim(); if (v && v !== it.title) api.patch(it.id, { title: v }); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          >{it.title}</h2>
          {ticketKeys(`${it.title} ${it.detail ?? ""}`).length > 0 && (
            <div className="tickets">
              {ticketKeys(`${it.title} ${it.detail ?? ""}`).map((k) => <a key={k} className="ticket" href={ticketUrl(k)} target="_blank" rel="noreferrer">{k} ↗</a>)}
            </div>
          )}
        </div>
        <div className="drawer-b">
          <WhySection it={it} />

          <div className="sec">
            <h4>State</h4>
            <div className="status-row">
              {STATUSES.map((s) => (
                <button key={s} className={`st ${it.status === s ? "on" : ""}`} onClick={() => api.setStatus(it.id, s)}>{s}</button>
              ))}
            </div>
          </div>

          <div className="sec">
            <h4>Correct me</h4>
            <div className="correct">
              <textarea
                value={note}
                placeholder="What's actually true? “Sam owns this now”, “not a ticket, just a chat”… Goes to memory. An instruction (“do it”, “ask Sam…”, “check…”) gets acted on."
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendNote(); }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="mini" onClick={sendNote}>Save note ⌘↵</button>
              <button className="mini" onClick={() => note.trim() && api.say(`About "${it.title}" (${it.id}): ${note.trim()}`).then(() => setNote(""))}>
                Let triage apply it
              </button>
            </div>
          </div>

          <div className="sec">
            <h4>Send an agent</h4>
            <div className="actions-grid">
              {ACTIONS.filter((a) => it.kind === "post" || !["draft", "publish"].includes(a.action)).map((a) => (
                <button key={a.action} className="act-btn" onClick={() => api.dispatch(it.id, a.action, note.trim() || undefined)}>
                  <Icon name={a.action} />
                  <b>{a.label}</b>
                  <span>{a.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sec">
            <h4>When</h4>
            <div className="sched-row">
              {quick("in 1 hour", new Date(Date.now() + 3600_000))}
              {quick("14:00", t(14, 0))}
              {quick("tomorrow 09:30", t(9, 30, 1))}
              {quick("Monday 09:30", t(9, 30, ((8 - new Date().getDay()) % 7) || 7))}
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              {at && <button className="st on" onClick={() => api.schedule(it.id, new Date(at).toISOString())}>Set</button>}
            </div>
          </div>

          <div className="sec">
            <h4>Source</h4>
            <div className="md">
              {it.source.type}{it.source.label ? ` · ${it.source.label}` : ""}
              {it.source.url && <> · <a href={it.source.url} target="_blank" rel="noreferrer">open</a></>}
              {it.confidence !== undefined && ` · confidence ${Math.round(it.confidence * 100)}%`}
              {it.confirmedAt ? ` · you confirmed ${ago(it.confirmedAt)}` : " · not confirmed by you yet"}
            </div>
            {it.links?.length ? (
              <div className="meta" style={{ marginTop: 8 }}>
                {it.links.map((l) => <a key={l} className="tag" href={l} target="_blank" rel="noreferrer">{shortUrl(l)}</a>)}
              </div>
            ) : null}
          </div>

          {itemJobs.length > 0 && (
            <div className="sec">
              <h4>Agents on this</h4>
              {itemJobs.map((j) => <JobCard key={j.id} j={j} />)}
            </div>
          )}

          {history.length > 0 && (
            <div className="sec">
              <h4>History</h4>
              <div className="hist">
                {history.map((j) => <div key={j.id}><time>{new Date(j.at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</time>{j.text}</div>)}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
