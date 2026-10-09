import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SyncState } from "../shared/types.ts";
import { quickFirst } from "../shared/batch.ts";
import { Deck } from "./deck.tsx";
import { AgentsPanel, Board, Drawer, Focus, JournalPage, JournalPanel, NowPanel, Timeline, TodayPanel } from "./parts.tsx";
import { api, useHQ, useNow } from "./store.ts";
import { Icon, ago } from "./ui.tsx";
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
  const [skipped, setSkipped] = useState<string[]>([]);
  const [deck, setDeck] = useState(false);
  const [quick, setQuick] = useState(() => localStorage.getItem("whq:quickFirst") === "1");
  useEffect(() => { localStorage.setItem("whq:quickFirst", quick ? "1" : "0"); }, [quick]);
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

  const queue = useMemo(() => {
    const t = now.getTime();
    const ready = s.questions.filter((q) => !q.notBefore || Date.parse(q.notBefore) <= t);
    ready.sort(quick ? quickFirst : (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    // Skipped go to the back, not away.
    return [...ready.filter((q) => !skipped.includes(q.id)), ...ready.filter((q) => skipped.includes(q.id))];
  }, [s.questions, skipped, now, quick]);
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
  const selected = sel ? s.items.find((i) => i.id === sel) : undefined;

  return (
    <div className={`app ${s.config.demo ? "demo-mode" : ""}`}>
      <TopBar sync={s.sync} connected={s.connected} memoryOn={s.config.memory} view={view} go={go} now={now} demo={s.config.demo} liveUrl={s.config.liveUrl} />
      <div className="main" style={view === "journal" ? { gridTemplateColumns: "1fr" } : undefined}>
        {view === "journal" ? (
          <div className="col"><JournalPage journal={s.journal} journalPath={s.config.memory ? s.config.journalPath : undefined} /></div>
        ) : (
          <>
            <div className="col left">
              <NowPanel now={now} events={s.events} workHours={s.config.workHours} />
              <Timeline now={now} events={s.events} items={s.items} onRefresh={() => api.sync("calendar")} sync={s.sync.find((x) => x.name === "calendar")} />
            </div>
            <div className="col center">
              {deck ? (
                <Deck
                  questions={queue}
                  items={s.items}
                  now={now}
                  onClose={() => setDeck(false)}
                  onFocus={(id) => { setDeck(false); setSkipped(queue.filter((q) => q.id !== id).map((q) => q.id)); }}
                />
              ) : (
              <div>
                <Focus
                  q={queue[0]}
                  total={queue.length}
                  items={s.items}
                  onSkip={() => queue[0] && setSkipped((x) => [...x.filter((y) => y !== queue[0]!.id), queue[0]!.id])}
                  onOpenItem={setSel}
                />
                {queue.length > 1 && (
                  <div className="queue">
                    {queue.slice(1, 8).map((q) => (
                      <button key={q.id} className="qchip" onClick={() => setSkipped((x) => [...x.filter((y) => y !== q.id), ...queue.slice(0, queue.indexOf(q)).map((y) => y.id)])} title={q.prompt}>
                        {q.prompt}
                      </button>
                    ))}
                    {queue.length > 8 && <span className="qchip">+{queue.length - 8} more</span>}
                    {later.length > 0 && <span className="qchip later">{later.length} snoozed</span>}
                  </div>
                )}
                <div className="kbd-help">
                  <kbd>1</kbd>–<kbd>9</kbd> answer · <kbd>s</kbd> skip · <kbd>n</kbd> note · <kbd>⌘↵</kbd> save note + skip · <kbd>⌘K</kbd> talk · <kbd>⌘.</kbd> 🍍
                  {queue.length > 1 && <> · <button className="kbd-btn" onClick={() => setDeck(true)}><kbd>b</kbd> clear the deck</button></>}
                  {" · "}<button className={`kbd-btn ${quick ? "on" : ""}`} onClick={() => setQuick((x) => !x)}><kbd>q</kbd> quick wins first{quick ? " ✓" : ""}</button>
                </div>
              </div>
              )}
              <Board items={s.items} selected={sel} onOpen={setSel} />
            </div>
            <div className="col right">
              <TodayPanel items={s.items} onOpen={setSel} selected={sel} />
              <AgentsPanel jobs={s.jobs} cmux={s.config.cmux} />
              <JournalPanel journal={s.journal} onAll={() => go("journal")} />
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
  const chip = (name: string, label: string) => {
    const x = sync.find((y) => y.name === name);
    const running = x?.lastRunAt && (!x.lastOkAt || x.lastRunAt > x.lastOkAt) && !x.error && Date.now() - Date.parse(x.lastRunAt) < 25 * 60_000;
    const cls = running ? "run" : x?.error ? "err" : x?.lastOkAt ? "ok" : "off";
    return (
      <button key={name} className="sync-chip" onClick={() => api.sync(name)} title={x?.error ?? `${x?.cursor ?? ""} — click to run now`}>
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
  const [listening, setListening] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [ticker, setTicker] = useState("");
  const [fired, setFired] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const voice = useRef<Voice | undefined>(undefined);
  // Someone else (the Focus card's "Scheduled for…") can borrow dictation.
  const target = useRef<((text: string, final: boolean) => void) | undefined>(undefined);

  const send = useCallback(async (t: string, mode: "chat" | "pineapple" = "chat") => {
    if (!t.trim()) return;
    setPending(true);
    setReply(undefined);
    try {
      const r = await api.say(t, mode);
      setReply(r.reply ?? "Done.");
    } catch (e) {
      setReply(`Couldn't: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  }, []);

  if (!voice.current) {
    voice.current = new Voice({
      onInterim: (t) => setTicker((x) => `${x} ${t}`.slice(-220)),
      onPineapple: (transcript) => {
        setFired(true);
        chime();
        setTimeout(() => setFired(false), 1000);
        if (transcript.trim()) send(transcript, "pineapple");
        else setReply("🍍 heard — but no transcript to capture from.");
      },
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
      onState: ({ listening: l, dictating: d, transcribing: t, error }) => {
        setListening(l || (voice.current?.listening ?? false));
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
      if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); togglePine(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const togglePine = () => {
    const v = voice.current!;
    if (v.listening) { v.stopListening(); setListening(false); setTicker(""); }
    else { v.startListening(); setListening(true); }
  };
  const toggleDictate = () => {
    const v = voice.current!;
    target.current = undefined;
    if (dictating) v.finishDictation();
    else v.startDictation();
  };

  return (
    <div className="bar-wrap">
      {listening && ticker && <div className="ticker"><span>{ticker}</span></div>}
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
        {speechSupported && (
          <button className={`pine ${listening ? "on" : ""} ${fired ? "fired" : ""}`} onClick={togglePine} title="Always-on 🍍 listener (⌘.)">
            <span className="fruit">🍍</span>{listening ? "listening" : "off"}
          </button>
        )}
        {listening && <button className="mini" onClick={() => voice.current?.fireNow()} title="Capture the last couple of minutes now">Capture now</button>}
        <button className="send" disabled={!text.trim() || pending} onClick={() => { const t = text; setText(""); send(t); }}>Send</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
