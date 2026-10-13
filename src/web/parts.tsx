import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, Item, ItemStatus, Job, JournalEntry, Question, SyncState } from "../shared/types.ts";
import { CalmScene } from "./calm.tsx";
import { api } from "./store.ts";
import { ACTIONS, Icon, KIND_LABEL, Md, Q_BADGE, ago, dictateInto, finishDictation, hhmm, people, shortUrl, stopDictation, whenLabel } from "./ui.tsx";

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
export function Focus({ q, total, items, onSkip, onBack, canBack, onOpenItem }: { q?: Question; total: number; items: Item[]; onSkip: () => void; onBack?: () => void; canBack?: boolean; onOpenItem: (id: string) => void }) {
  const [note, setNote] = useState("");
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
  useEffect(() => { setNote(""); setBusy(false); setWhenFor(undefined); }, [q?.id]);
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
    try { await api.answer(q.id, optionId, text || undefined, itemIds ?? (q.kind === "plan" ? picked : undefined)); }
    catch { setBusy(false); }
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
    try {
      await api.note(q.id, text);
      setNote("");
      noteRef.current?.blur();
    } catch (e) {
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
        <span className="focus-count">1 of {total}</span>
      </div>
      <h1>{q.prompt}</h1>
      {q.context && <Md className="ctx md" text={q.context} />}
      {item?.notes?.length ? (
        <div className="ctx prior-notes" title="What you said about this before">
          {item.notes.slice(-2).map((n) => <div key={n.at}>✎ <span className="when">{relDay(n.at)}</span> {n.text}</div>)}
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
            <kbd>{i + 1}</kbd>{q.kind === "plan" && o.id === "plan" ? `Commit to ${picked.length || "these"}` : o.label}
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
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(); }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          placeholder={q.kind === "review" ? "What came out of it? (goes to triage)  ⌘↵ send" : "Tell me what to do, or correct me — I'll act on it  (n · ⌘↵)"}
        />
        {note.trim() && <button className="skip send" disabled={busy} onClick={saveNote}>Send ⌘↵</button>}
        <button className="skip" onClick={onSkip} title="Next card, nothing changes (s or →)">Next →</button>
      </div>
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

function score(i: Item, now = Date.now()) {
  let s = 0;
  const kill = i.signals?.killDate ? Date.parse(i.signals.killDate) : undefined;
  if (kill && kill - now < 3 * 86400000) s += 3;
  if (i.signals?.dueDate && Date.parse(i.signals.dueDate) - now < 7 * 86400000) s += 2;
  if (i.signals?.pineapple) s += 2;
  if (i.source.label?.includes("Immediate")) s += 2;
  if (i.kind === "decision") s += 1;
  if (i.status === "inbox") s += 1;
  if (i.kind === "idea") s -= 1;
  return s;
}

function Planner({ items, picked, setPicked }: { items: Item[]; picked: string[]; setPicked: (x: string[]) => void }) {
  const cands = useMemo(() => {
    const today = items.filter((i) => i.status === "today" || i.status === "doing");
    const rest = items.filter((i) => ["proposed", "inbox"].includes(i.status)).sort((a, b) => score(b) - score(a)).slice(0, 14 - today.length);
    return [...today, ...rest];
  }, [items.length]);
  useEffect(() => { setPicked(cands.filter((i) => i.status === "today" || i.status === "doing").map((i) => i.id)); }, [cands]);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <div className="pick">
      {cands.map((i) => (
        <button key={i.id} className={`pick-row ${picked.includes(i.id) ? "on" : ""}`} onClick={() => toggle(i.id)}>
          <span className="tick">✓</span>
          <span>
            <div style={{ fontSize: 13.5 }}>{i.title}</div>
            <div className="meta">
              {i.project && <span className="tag proj">{i.project}</span>}
              {i.signals?.killDate && <span className="tag warn">kill {i.signals.killDate.slice(5)}</span>}
              {i.signals?.pineapple && <span className="tag src-pineapple">🍍</span>}
              <span className="tag">{i.source.label?.replace("active-todos · ", "") ?? i.source.type}</span>
            </div>
          </span>
          <span className="tag">{KIND_LABEL[i.kind]}</span>
        </button>
      ))}
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
          <span style={{ fontSize: 13.5 }}>{i.title}</span>
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
        <div className="title">{it.title}</div>
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
  const L = LANES.find((l) => l.id === lane)!;
  const list = items
    .filter(L.test)
    .filter((i) => !q || `${i.title} ${i.project ?? ""} ${i.detail ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (lane === "scheduled" ? (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "") : score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt)));
  return (
    <div className="panel">
      <div className="lanes-h">
        {LANES.map((l) => (
          <button key={l.id} className={`lane-tab ${lane === l.id ? "on" : ""}`} onClick={() => setLane(l.id)}>
            {l.label} <span className="n">{items.filter(l.test).length}</span>
          </button>
        ))}
        <input className="filter-in" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="items">
        {list.map((i) => <ItemRow key={i.id} it={i} selected={selected === i.id} onOpen={() => onOpen(i.id)} />)}
        {!list.length && <div className="empty">{lane === "inbox" ? "No fresh captures. Transcripts and 🍍 land here." : "Nothing here."}</div>}
      </div>
    </div>
  );
}

export function TodayPanel({ items, onOpen, selected }: { items: Item[]; onOpen: (id: string) => void; selected?: string }) {
  const todayStr = new Date().toDateString();
  const list = items.filter(
    (i) => ["today", "doing"].includes(i.status) || (i.status === "done" && new Date(i.updatedAt).toDateString() === todayStr),
  ).sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  const [adding, setAdding] = useState("");
  const done = list.filter((i) => i.status === "done").length;
  return (
    <div className="panel today">
      <div className="panel-h">
        <h3>Committed</h3>
        <span className="count">{done}/{list.length}</span>
      </div>
      <div className="items">
        {list.map((i) => <ItemRow key={i.id} it={i} compact selected={selected === i.id} onOpen={() => onOpen(i.id)} />)}
        {!list.length && <div className="empty">Nothing committed yet. The morning plan fixes that.</div>}
      </div>
      <input
        className="note-in"
        style={{ marginTop: 10, width: "100%" }}
        placeholder="+ Add a commitment"
        value={adding}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && adding.trim()) { api.add(adding.trim()); setAdding(""); } }}
      />
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
export function JournalPanel({ journal, onAll }: { journal: JournalEntry[]; onAll: () => void }) {
  const pending = journal.filter((j) => !j.synced).length;
  return (
    <div className="panel">
      <div className="panel-h">
        <h3>Journal</h3>
        {pending > 0 && <span className="count" title="Not yet written to memory" style={{ color: "var(--gold)" }}>{pending} unsaved</span>}
        <button className="act" onClick={onAll}>All →</button>
      </div>
      {journal.slice(0, 10).map((j) => <JRow key={j.id} j={j} />)}
      {!journal.length && <div className="empty">Every decision you make here is written down, then saved to memory.</div>}
    </div>
  );
}

function JRow({ j }: { j: JournalEntry }) {
  return (
    <div className="jr">
      <time>{hhmm(j.at)}</time>
      <div className={`who-${j.who}`}>{j.text}{!j.synced && <span className="unsynced" title="Not in memory yet" />}</div>
    </div>
  );
}

export function JournalPage({ journal, journalPath }: { journal: JournalEntry[]; journalPath?: string }) {
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
          {list.map((j) => <JRow key={j.id} j={j} />)}
        </div>
      ))}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────
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
        </div>
        <div className="drawer-b">
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
                placeholder="What's actually true? “Already done on Tuesday”, “Sam owns this now”, “not a ticket, just a chat”… Goes to memory."
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

          {(it.source.quote || it.detail) && (
            <div className="sec">
              <h4>Why this exists</h4>
              {it.source.quote && <div className="quote-block">“{it.source.quote}”</div>}
              <Md text={it.detail} />
            </div>
          )}

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
