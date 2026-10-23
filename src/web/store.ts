import { useEffect, useReducer, useRef, useState } from "react";
import type { BulkRequest } from "../shared/batch.ts";
import type { ActionKind, Item, ItemStatus, ServerEvent, Snapshot } from "../shared/types.ts";
import { setProfile, setTracker } from "./ui.tsx";

type State = Snapshot & { connected: boolean; toasts: Array<{ id: number; text: string; tone?: string }> };

const empty: State = {
  items: [], questions: [], jobs: [], events: [], upcoming: [], journal: [], sync: [],
  config: {
    port: 7717, demo: false, cmux: false, memory: false, model: "", workHours: [8, 19],
    owner: { name: "", aliases: [], speechLang: "en-GB" },
    labels: { tracker: "tracker", chat: "chat", wiki: "wiki", site: "site" },
    journalPath: "",
  },
  connected: false, toasts: [],
};

function upsert<T extends { id: string }>(list: T[], x: T) {
  const i = list.findIndex((y) => y.id === x.id);
  if (i < 0) return [x, ...list];
  const next = list.slice();
  next[i] = x;
  return next;
}

let toastId = 0;

function reducer(s: State, e: ServerEvent | { type: "conn"; up: boolean } | { type: "toast:drop"; id: number }): State {
  switch (e.type) {
    case "snapshot":
      if (e.data.config?.owner) setProfile(e.data.config.owner);
      setTracker(e.data.config?.labels?.trackerUrl);
      // No load in a fresh snapshot means no recent sample: drop the old chip.
      return { ...s, load: undefined, ...e.data };
    case "item": return { ...s, items: upsert(s.items, e.data) };
    case "item:remove": return { ...s, items: s.items.filter((i) => i.id !== e.id) };
    case "question":
      return {
        ...s,
        questions: e.data.status === "open" ? upsert(s.questions, e.data) : s.questions.filter((q) => q.id !== e.data.id),
      };
    case "job": return { ...s, jobs: upsert(s.jobs, e.data) };
    case "events": return { ...s, events: e.data };
    case "upcoming": return { ...s, upcoming: e.data };
    case "journal": return { ...s, journal: upsert(s.journal, e.data).slice(0, 300) };
    case "coaching": return { ...s, coaching: e.data };
    case "load": return { ...s, load: e.data };
    case "sync": return { ...s, sync: upsert(s.sync.map((x) => ({ ...x, id: x.name })), { ...e.data, id: e.data.name }) };
    case "toast": return { ...s, toasts: [...s.toasts, { id: ++toastId, ...e.data }].slice(-4) };
    case "toast:drop": return { ...s, toasts: s.toasts.filter((t) => t.id !== e.id) };
    case "conn": return { ...s, connected: e.up };
    default: return s;
  }
}

export function useHQ(onNotify: (n: { title: string; body: string }) => void) {
  const [state, dispatch] = useReducer(reducer, empty);
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry = 500;
    let dead = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => { retry = 500; dispatch({ type: "conn", up: true }); };
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data) as ServerEvent;
        if (e.type === "notify") notifyRef.current(e.data);
        else dispatch(e);
        if (e.type === "toast") setTimeout(() => dispatch({ type: "toast:drop", id: toastId }), 4200);
      };
      ws.onclose = () => {
        dispatch({ type: "conn", up: false });
        if (!dead) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
      };
    };
    connect();
    return () => { dead = true; ws?.close(); };
  }, []);

  return state;
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const api = {
  answer: (id: string, optionId: string, note?: string, itemIds?: string[], picks?: string[]) =>
    call("POST", `/api/questions/${id}/answer`, { optionId, note, itemIds, picks }),
  /** A typed note on a question. The server acts on it (answer / status / schedule / agent) or parks it till tomorrow. */
  note: (id: string, text: string) => call<{ pending: boolean }>("POST", `/api/questions/${id}/note`, { text }),
  item: (id: string) => call<Item>("GET", `/api/items/${id}`),
  setStatus: (id: string, status: ItemStatus, note?: string) => call("PATCH", `/api/items/${id}`, { status, note }),
  patch: (id: string, patch: Record<string, unknown>) => call("PATCH", `/api/items/${id}`, patch),
  explain: (id: string) => call<Item>("POST", `/api/items/${id}/explain`),
  dispatch: (id: string, action: ActionKind, note?: string) => call("POST", `/api/items/${id}/dispatch`, { action, note }),
  schedule: (id: string, at: string, label?: string) => call("POST", `/api/items/${id}/schedule`, { at, label }),
  add: (title: string, status: ItemStatus = "today") => call("POST", "/api/items", { title, status }),
  say: (text: string, mode: "chat" | "pineapple" | "review" = "chat") => call<{ reply?: string }>("POST", "/api/say", { text, mode }),
  bulk: (req: BulkRequest) => call<{ count: number; skipped: number }>("POST", "/api/questions/bulk", req),
  sync: (name: string) => call("POST", `/api/sync/${name}`),
  focusJob: (id: string) => call("POST", `/api/jobs/${id}/focus`),
  cancelJob: (id: string) => call("POST", `/api/jobs/${id}/cancel`),
  /** One agent checks every open agent card and live session against the real state and closes the stale ones. */
  bossCheck: () => call("POST", "/api/agents/boss"),
  /** Live dashboard: start (or restart, with reset) the demo sandbox and get its URL. */
  demoStart: (reset = false) => call<{ url: string }>("POST", `/api/demo/start${reset ? "?reset=1" : ""}`),
  demoStop: () => call("POST", "/api/demo/stop"),
  /** Demo dashboard: wipe and reseed the made-up day. */
  demoReset: () => call("POST", "/api/demo/reset"),
};

/** Re-render every `ms` — for clocks and relative times. */
export function useNow(ms = 15_000) {
  const [now, set] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => set(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
