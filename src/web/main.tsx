import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Item, SyncState } from "../shared/types.ts";
import { quickFirst } from "../shared/batch.ts";
import { type Pin, pinQueue, takePin } from "../shared/pin.ts";
import { back, canBack, emptyNav, focusOn, jump, type Nav, next, orderQueue, readNav } from "../shared/skip.ts";
import { Deck } from "./deck.tsx";
import { AgentsPanel, Board, CoachingPanel, Drawer, Focus, JournalPage, NowPanel, Timeline, TodayPanel } from "./parts.tsx";
import { api, useHQ, useNow } from "./store.ts";
import { Icon, ago, useStoredFlag } from "./ui.tsx";
import { Voice, chime, micSupported, speechSupported } from "./voice.ts";

function App() {
  const notify = useCallback((n: { title: string; body: string }) => {
    chime();
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const note = new Notification(n.title, { body: n.body, silent: true, tag: n.body });
      note.onclick = () => { window.focus(); note.close(); };
    }
  }, []);
  const s = useHQ(notify);
  const now = useNow(15_000);
  const [view, setView] = useState<"today" | "journal">(location.pathname === "/journal" ? "journal" : "today");
  const [sel, setSel] = useState<string | undefined>();
  // "Next" is navigation only: nothing is sent. Kept per tab so a reload doesn't put a skipped card back on top.
  // Back restores the list from before the last move (src/shared/skip.ts).
  // Storage off or full: navigation still works, it just isn't kept across a reload.
  const [skips, setSkips] = useState<Nav>(() => { try { return readNav(sessionStorage.getItem("whq:nav"), sessionStorage.getItem("whq:skipped")); } catch { return emptyNav(); } });
  useEffect(() => {
    try { sessionStorage.setItem("whq:nav", JSON.stringify(skips)); sessionStorage.removeItem("whq:skipped"); } catch { /* see above */ }
  }, [skips]);
  const [deck, setDeck] = useState(false);
  const [quick, setQuick] = useStoredFlag("whq:quickFirst", false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "D") { e.preventDefault(); window.dispatchEvent(new Event("whq:demo-toggle")); }
      else if (e.key === "b") { e.preventDefault(); setDeck((x) => !x); }
      else if (e.key === "q") { e.preventDefault(); setQuick((x) => !x); }
      else if (e.key === "Escape") setDeck(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // Ask once for notification permission, on the first interaction (browsers require a gesture).
  useEffect(() => {
    const ask = () => { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); };
    window.addEventListener("pointerdown", ask, { once: true });
    return () => window.removeEventListener("pointerdown", ask);
  }, []);

  const ready = useMemo(() => {
    const t = now.getTime();
    const r = s.questions.filter((q) => !q.notBefore || Date.parse(q.notBefore) <= t);
    return r.sort(quick ? quickFirst : (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }, [s.questions, now, quick]);
  // Skipped go to the back, not away, in the order you skipped them (src/shared/skip.ts).
  const order = useMemo(() => orderQueue(ready, skips.skipped), [ready, skips.skipped]);
  // While you're writing on a card (note focused, note has text, or dictating), it stays in front.
  // New arrivals queue behind it and show as "+N new". Released when you stop, answer, skip or go back.
  const [hold, setHold] = useState(false);
  const [pin, setPin] = useState<Pin | undefined>();
  const { queue, fresh } = useMemo(() => pinQueue(order, pin), [order, pin]);
  useEffect(() => {
    if (hold && !pin) setPin(takePin(queue));
    else if (!hold && pin) setPin(undefined);
  }, [hold, pin, queue]);
  // Explicit navigation: drop the pin and tell Focus to clear the note.
  const [nav, setNav] = useState(0);
  const navigate = (fn: () => void) => { setPin(undefined); setNav((n) => n + 1); fn(); };
  const later = s.questions.filter((q) => q.notBefore && Date.parse(q.notBefore) > now.getTime());

  useEffect(() => {
    const name = s.config.demo ? "Work HQ · demo" : "Work HQ";
    document.title = queue.length ? `(${queue.length}) ${name}` : name;
  }, [queue.length, s.config.demo]);

  // Back from the demo ("Exit demo" lands on /?exitDemo=1): stop the sandbox, tidy the URL.
  useEffect(() => {
    if (new URLSearchParams(location.search).has("exitDemo")) {
      void api.demoStop().catch(() => {});
      history.replaceState(null, "", location.pathname);
    }
  }, []);

  const go = (v: "today" | "journal") => { setView(v); history.replaceState(null, "", v === "today" ? "/" : "/journal"); };
  // The snapshot drops items closed more than 3 days ago; a journal row can still point at one, so fetch it.
  const [fetched, setFetched] = useState<Item | undefined>();
  const openItem = useCallback((id: string) => {
    setSel(id);
    if (!s.items.some((i) => i.id === id)) api.item(id).then(setFetched, () => setSel(undefined));
  }, [s.items]);
  const selected = sel ? s.items.find((i) => i.id === sel) ?? (fetched?.id === sel ? fetched : undefined) : undefined;

  return (
    <div className={`app ${s.config.demo ? "demo-mode" : ""}`}>
      <TopBar sync={s.sync} connected={s.connected} memoryOn={s.config.memory} view={view} go={go} now={now} demo={s.config.demo} liveUrl={s.config.liveUrl} />
      <div className="main" style={view === "journal" ? { gridTemplateColumns: "1fr" } : undefined}>
        {view === "journal" ? (
          <div className="col"><JournalPage journal={s.journal} journalPath={s.config.memory ? s.config.journalPath : undefined} onOpenItem={openItem} /></div>
        ) : (
          <>
            <div className="col left">
              <NowPanel now={now} events={s.events} workHours={s.config.workHours} />
              <Timeline now={now} events={s.events} items={s.items} questions={s.questions} onRefresh={() => api.sync("calendar")} sync={s.sync.find((x) => x.name === "calendar")} />
            </div>
            <div className="col center">
              {deck ? (
                <Deck
                  questions={queue}
                  allQuestions={s.questions}
                  items={s.items}
                  events={[...s.events, ...(s.upcoming ?? [])]}
                  calendarThrough={s.sync.find((x) => x.name === "calendar")?.through}
                  workHours={s.config.workHours}
                  now={now}
                  onClose={() => setDeck(false)}
                  onFocus={(id) => navigate(() => { setDeck(false); setSkips((x) => focusOn(x, queue, id)); })}
                />
              ) : (
              <div>
                <Focus
                  q={queue[0]}
                  total={queue.length}
                  fresh={fresh}
                  nav={nav}
                  onHold={setHold}
                  items={s.items}
                  onSkip={() => navigate(() => setSkips((x) => next(x, queue)))}
                  canBack={queue.length > 1 && canBack(skips, ready, queue[0]?.id)}
                  onBack={() => navigate(() => setSkips((x) => back(x, ready, queue[0]?.id)))}
                  onOpenItem={setSel}
                />
                {queue.length > 1 && (
                  <div className="queue">
                    {queue.slice(1, 8).map((q) => (
                      <button key={q.id} className="qchip" onClick={() => navigate(() => setSkips((x) => jump(x, queue, q.id)))} title={q.prompt}>
                        {q.prompt}
                      </button>
                    ))}
                    {queue.length > 8 && <span className="qchip">+{queue.length - 8} more</span>}
                    {later.length > 0 && <span className="qchip later">{later.length} snoozed</span>}
                  </div>
                )}
                <div className="kbd-help">
                  <kbd>1</kbd>–<kbd>9</kbd> answer · <kbd>→</kbd>/<kbd>s</kbd> next · <kbd>←</kbd> back · <kbd>n</kbd> note · <kbd>⌘↵</kbd> send note (acts on it) · <kbd>⌘K</kbd> talk
                  {queue.length > 1 && <> · <button className="kbd-btn" onClick={() => setDeck(true)}><kbd>b</kbd> clear the deck</button></>}
                  {" · "}<button className={`kbd-btn ${quick ? "on" : ""}`} onClick={() => setQuick((x) => !x)}><kbd>q</kbd> quick wins first{quick ? " ✓" : ""}</button>
                </div>
              </div>
              )}
              <Board items={s.items} selected={sel} onOpen={setSel} />
            </div>
            <div className="col right">
              <TodayPanel items={s.items} jobs={s.jobs} onOpen={setSel} selected={sel} />
              <CoachingPanel c={s.coaching} now={now} />
              <AgentsPanel jobs={s.jobs} cmux={s.config.cmux} load={s.load} questions={s.questions} />
            </div>
          </>
        )}
      </div>
      <CommandBar />
      {selected && <Drawer it={selected} journal={s.journal} jobs={s.jobs} onClose={() => setSel(undefined)} />}
      <div className="toasts">{s.toasts.map((t) => <div key={t.id} className={`toast ${t.tone ?? ""}`}>{t.text}</div>)}</div>
      {!s.connected && <div className="offline badge coral">Reconnecting to Work HQ…</div>}
    </div>
  );
}

/** Live: "Demo" starts the sandbox and hops over. Demo: a loud badge, a reset, and a guarded way back. */
function DemoToggle({ demo, liveUrl }: { demo: boolean; liveUrl?: string }) {
  const [busy, setBusy] = useState(false);
  const start = useCallback(async () => {
    setBusy(true);
    try {
      const { url } = await api.demoStart(true);
      location.href = url;
    } catch (e) {
      alert(`Couldn't start the demo: ${(e as Error).message}`);
      setBusy(false);
    }
  }, []);
  const exit = useCallback(() => {
    if (confirm("Leave the demo? The next screen is your REAL dashboard.")) location.href = `${liveUrl ?? "http://localhost:7717"}/?exitDemo=1`;
  }, [liveUrl]);
  useEffect(() => {
    const t = () => (demo ? exit() : start());
    window.addEventListener("whq:demo-toggle", t);
    return () => window.removeEventListener("whq:demo-toggle", t);
  }, [demo, exit, start]);
  if (!demo) {
    return (
      <button className="demo-btn" onClick={start} disabled={busy} title="Switch to a sandbox with made-up data, safe to screen-share (⇧D)">
        {busy ? "Starting demo…" : "Demo"}
      </button>
    );
  }
  return (
    <div className="demo-pill" title="Made-up data. Agents and sweeps are scripted. Nothing real is read or touched.">
      <span className="demo-dot" />DEMO
      <button onClick={() => api.demoReset()} title="Wipe and load a fresh made-up day">Reset</button>
      <button onClick={exit} title="Back to the live dashboard (⇧D)">Exit</button>
    </div>
  );
}

function TopBar({ sync, connected, memoryOn, view, go, now, demo, liveUrl }: { sync: SyncState[]; connected: boolean; memoryOn: boolean; view: string; go: (v: "today" | "journal") => void; now: Date; demo: boolean; liveUrl?: string }) {
  const chip = (name: string, label: string, run: () => unknown = () => api.sync(name), title?: string) => {
    const x = sync.find((y) => y.name === name);
    const running = x?.lastRunAt && (!x.lastOkAt || x.lastRunAt > x.lastOkAt) && !x.error && Date.now() - Date.parse(x.lastRunAt) < 25 * 60_000;
    const cls = running ? "run" : x?.error ? "err" : x?.lastOkAt ? "ok" : "off";
    return (
      <button key={name} className="sync-chip" onClick={run} title={[title, x?.error ?? `${x?.cursor ?? ""} — click to run now`].filter(Boolean).join("\n")}>
        <span className={`dot ${cls}`} />{label}<span style={{ color: "var(--text-3)" }}>{running ? "…" : ago(x?.lastOkAt, now.getTime())}</span>
      </button>
    );
  };
  return (
    <div className="top">
      <div className="brand"><span className="brand-mark" />Work HQ</div>
      <div className="nav">
        <button className={view === "today" ? "on" : ""} onClick={() => go("today")}>Today</button>
        <button className={view === "journal" ? "on" : ""} onClick={() => go("journal")}>Journal</button>
      </div>
      <DemoToggle demo={demo} liveUrl={liveUrl} />
      <span className="spacer" />
      <div className="chips">
        {memoryOn || demo ? chip("memory", "memory") : <span className="sync-chip"><span className="dot err" />memory off</span>}
        {chip("transcripts", "transcripts")}
        {chip("calendar", "calendar")}
        {chip("journal", "saved")}
        {!demo && chip("recheck", "recheck", () => api.recheck(), "Look up every open item's MRs, PRs and tickets now. Anything that landed goes on one card to tick off.")}
        {!connected && <span className="sync-chip"><span className="dot err" />offline</span>}
      </div>
    </div>
  );
}

// ── command bar + voice ───────────────────────────────────────────────────
function CommandBar() {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<string | undefined>();
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const voice = useRef<Voice | undefined>(undefined);
  // Someone else (the Focus card's "Scheduled for…") can borrow dictation.
  const target = useRef<((text: string, final: boolean) => void) | undefined>(undefined);

  const send = useCallback(async (t: string) => {
    if (!t.trim()) return;
    setPending(true);
    setReply(undefined);
    try {
      const r = await api.say(t);
      // reply-safe: the triage reply, same text as its job summary (agents.triage).
      setReply(r.reply ?? "Done.");
    } catch (e) {
      setReply(`Couldn't: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  }, []);

  if (!voice.current) {
    voice.current = new Voice({
      onDictation: (t, final) => {
        if (target.current) {
          const fn = target.current;
          if (final) target.current = undefined;
          fn(t, final);
          return;
        }
        setText(t);
        if (final && t.trim()) setTimeout(() => input.current?.focus(), 0);
      },
      onState: ({ dictating: d, transcribing: t, error }) => {
        setDictating(d);
        setTranscribing(Boolean(t));
        setErr(error);
        window.dispatchEvent(new CustomEvent("whq:dictate-phase", { detail: t ? "transcribing" : d ? "listening" : "idle" }));
      },
    });
  }

  useEffect(() => {
    const start = (e: Event) => { target.current = (e as CustomEvent).detail; voice.current?.startDictation(); };
    // Swallow the final result of a cancelled borrow so it doesn't land in the command bar.
    const stop = () => { if (target.current) target.current = () => {}; voice.current?.stopDictation(); };
    const finish = () => voice.current?.finishDictation();
    window.addEventListener("whq:dictate", start);
    window.addEventListener("whq:dictate-stop", stop);
    window.addEventListener("whq:dictate-finish", finish);
    return () => {
      window.removeEventListener("whq:dictate", start);
      window.removeEventListener("whq:dictate-stop", stop);
      window.removeEventListener("whq:dictate-finish", finish);
    };
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const toggleDictate = () => {
    const v = voice.current!;
    // The command bar takes the mic back: a borrower (a meeting row's box) lets go instead of waiting for a final.
    window.dispatchEvent(new CustomEvent("whq:dictate-take"));
    target.current = undefined;
    if (dictating) v.finishDictation();
    else v.startDictation();
  };

  return (
    <div className="bar-wrap">
      {(pending || reply || err) && (
        <div className="reply">
          {pending ? <><span className="thinking"><i /><i /><i /></span> Thinking…</> : err ? <b style={{ color: "var(--coral)" }}>{err}</b> : <><span>◆</span><b>{reply}</b><span className="spacer" style={{ flex: 1 }} /><button className="skip" onClick={() => setReply(undefined)}>✕</button></>}
        </div>
      )}
      <div className="bar">
        {(speechSupported || micSupported) && (
          <button className={`mic ${dictating || transcribing ? "on" : ""}`} onClick={toggleDictate} title="Dictate">
            <Icon name="mic" />
          </button>
        )}
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() && !pending) { const t = text; setText(""); send(t); }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          placeholder={transcribing ? "Transcribing…" : dictating ? "Listening…" : "Tell Work HQ anything — “PAY-123 is closed”, “remind me to reply to Sam after standup”, “file a ticket for…”"}
        />
        <span className="hint">⌘K</span>
        <button className="send" disabled={!text.trim() || pending} onClick={() => { const t = text; setText(""); send(t); }}>Send</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
