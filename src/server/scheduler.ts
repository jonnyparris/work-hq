// The heartbeat. Cheap ticks run often; expensive pi sweeps run on cadence
// during work hours only, and only while the laptop is awake (which is the
// whole limitation the cloud/ DO scaffold exists to lift later).

import type { Agents } from "./agents.ts";
import type { Checks } from "./checks.ts";
import { config, memoryOn, sweepOn } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { MemorySync } from "./memory-sync.ts";
import { NOTES_WINDOWS_MIN, type Prompter } from "./prompter.ts";

/** A cadence tick (every 60 s) this late means the laptop slept. */
export const WOKE_GAP_MS = 2 * 60_000;
/**
 * No sweeps this long after a wake. macOS Power Nap DarkWakes last 2\u201310 s (one 119 s on AC, 10-19) and
 * fire the overdue cadence tick, so a sweep started then froze seconds later and failed on the next wake.
 * A real wake just waits 3 min; a DarkWake is asleep again long before.
 */
export const WAKE_GRACE_MS = 3 * 60_000;

export class Scheduler {
  private timers: Timer[] = [];
  private last: Record<string, number> = {};
  private lastCadence = Date.now();
  private wokeAt = 0;
  /** True while a restart waits for headless jobs (src/server/restart.ts): start no new sweeps meanwhile. */
  held: () => boolean = () => false;

  constructor(
    private hub: Hub,
    private prompter: Prompter,
    private agents: Agents,
    private memory: MemorySync,
    private checks?: Checks,
  ) {}

  start() {
    const safe = (name: string, fn: () => unknown) => async () => {
      try {
        await fn();
      } catch (e) {
        console.error(`[${name}]`, (e as Error).message ?? e);
      }
    };
    this.timers.push(setInterval(safe("cmux", () => this.agents.pollCmux()), 3_000));
    this.timers.push(setInterval(safe("prompter", () => this.prompter.tick()), 30_000));
    this.timers.push(setInterval(safe("cadence", () => this.cadence()), 60_000));
    // Load average once a minute, for "does load follow job counts?" after the fact (src/server/load.ts).
    this.timers.push(setInterval(safe("load", () => this.hub.sampleLoad(this.agents.runningActions())), 60_000));
    // Load falls without any job stopping, so launches held by pi.maxLoad need a nudge.
    this.timers.push(setInterval(safe("load-gate", () => config.pi.maxLoad > 0 && this.agents.cap.pump()), 15_000));
    // First pass shortly after boot.
    setTimeout(safe("boot", () => this.boot()), 500);
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  private async boot() {
    try {
      this.hub.sampleLoad(this.agents.runningActions()); // a load chip before the first minute
    } catch (e) {
      console.error("[load]", (e as Error).message);
    }
    if (memoryOn()) await this.memory.importAll().catch((e) => console.error("[memory]", e.message));
    this.prompter.tick();
    this.last.memory = Date.now();
    if (config.sweeps.enabled && this.inWorkHours()) {
      // Only what's due. Every boot used to sweep the calendar and transcripts again, so a run of restarts
      // (landings) started a sweep each time, and the next restart killed it (10-21).
      const cal = this.bootDue("calendar", config.sweeps.calendarEveryMin);
      const tr = this.bootDue("transcripts", config.sweeps.transcriptsEveryMin);
      if (cal && sweepOn("calendar")) void this.agents.sweep("calendar");
      // Stagger: transcripts a minute later so two cold pi starts don't collide.
      if (tr && sweepOn("transcripts")) setTimeout(() => void this.agents.sweep("transcripts"), cal ? 60_000 : 0);
    }
  }

  /**
   * At boot: is this sweep due, going by its last good run (persisted)? Seeds the cadence clock either way,
   * so a sweep that ran 10 min before a restart waits out the rest of its interval.
   */
  bootDue(name: "calendar" | "transcripts", everyMin: number, now = Date.now()) {
    const ok = Date.parse(this.hub.store.syncState(name).lastOkAt ?? "");
    const due = Number.isNaN(ok) || now - ok >= everyMin * 60_000;
    this.last[name] = due ? now : ok;
    return due;
  }

  inWorkHours(now = new Date()) {
    const [a, b] = config.sweeps.workHours;
    const h = now.getHours();
    return now.getDay() !== 0 && now.getDay() !== 6 && h >= a && h < b;
  }

  private due(name: string, everyMin: number) {
    return Date.now() - (this.last[name] ?? 0) >= everyMin * 60_000;
  }

  /** Track cadence ticks; true while we're inside the grace window after the laptop woke. */
  justWoke(now = Date.now()) {
    if (now - this.lastCadence > WOKE_GAP_MS) this.wokeAt = now;
    this.lastCadence = now;
    return now - this.wokeAt < WAKE_GRACE_MS;
  }

  /** Start a sweep; one that failed after the laptop slept mid-run is due again on the next awake tick. */
  private startSweep(name: "calendar" | "transcripts") {
    void this.agents.sweep(name).then((r) => {
      if (r?.rerun) delete this.last[name];
    });
  }

  private async cadence() {
    const woke = this.justWoke();
    if (this.due("cmuxPrune", 10)) {
      this.last.cmuxPrune = Date.now();
      this.agents.pruneCmux();
    }
    if (config.demo && this.due("journal", 1)) {
      // Demo: pretend the journal was saved, so the "saved" chip and journal dots behave like the real thing.
      this.last.journal = Date.now();
      const pending = this.hub.store.unsyncedJournal();
      for (const e of pending) this.hub.store.putJournal({ ...e, synced: true });
      if (pending.length) this.hub.putSync({ ...this.hub.store.syncState("journal"), lastRunAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), cursor: `${pending.length} entries` });
    }
    if (this.due("journal", config.memory.flushEveryMin) && memoryOn()) {
      this.last.journal = Date.now();
      await this.memory.flushJournal().catch((e) => console.error("[journal]", e.message));
    }
    if (this.due("memory", config.memory.importEveryMin) && memoryOn()) {
      this.last.memory = Date.now();
      await this.memory.importAll().catch((e) => console.error("[memory]", e.message));
    }
    if (!config.sweeps.enabled || !this.inWorkHours() || woke || this.held()) return;
    // Model gateway login lapsed: every pi run would fail. One retry every 30 min, else wait for the login.
    if (this.agents.gatewayBlocked()) return;
    // Cheap shell checks, once per workday, ahead of the morning plan.
    if (this.checks && sweepOn("checks")) void this.checks.runDue().catch((e) => console.error("[checks]", e.message));
    if (sweepOn("calendar") && this.due("calendar", config.sweeps.calendarEveryMin)) {
      this.last.calendar = Date.now();
      this.startSweep("calendar");
    }
    // A meeting with others ended 10–25 or 45–60 min ago (NOTES_WINDOWS_MIN) and nothing has scanned in that window
    // yet: scan now, so its "anything you committed to?" card closes itself instead of waiting for the next cadence.
    if (sweepOn("transcripts") && this.meetingNotesDue()) {
      this.last.transcripts = Date.now();
      this.startSweep("transcripts");
    } else if (sweepOn("transcripts") && this.due("transcripts", config.sweeps.transcriptsEveryMin)) {
      this.last.transcripts = Date.now();
      this.startSweep("transcripts");
    }
    // Writing scout: weekly, persisted in sync state so restarts don't re-run it. Retry a failure after 6h.
    const posts = this.hub.store.syncState("posts");
    const age = (iso?: string) => (iso ? Date.now() - Date.parse(iso) : Infinity);
    if (sweepOn("posts") && config.sweeps.postsEveryDays > 0 && age(posts.lastOkAt) > config.sweeps.postsEveryDays * 86400_000 && age(posts.lastRunAt) > 6 * 3600_000 && new Date().getHours() >= 10) {
      void this.agents.postSweep();
    }
  }

  meetingNotesDue(now = Date.now()) {
    return this.hub.todayEvents(new Date(now)).some((ev) => {
      const end = Date.parse(ev.end);
      const meeting = ev.oneOnOne || (ev.attendees?.length ?? 0) > 1;
      if (!meeting || ev.response === "declined") return false;
      const win = NOTES_WINDOWS_MIN.find(([from, to]) => now - end >= from * 60_000 && now - end <= to * 60_000);
      return !!win && (this.last.transcripts ?? 0) < end + win[0] * 60_000 && !this.hub.wasScanned(ev);
    });
  }

  /** Manual trigger from the UI. */
  async run(name: "memory" | "journal" | "calendar" | "transcripts" | "posts", since?: string) {
    this.last[name] = Date.now();
    if (name === "journal" && config.demo) return;
    if (name === "memory" && config.demo) return;
    if (name === "memory") return this.memory.importAll();
    if (name === "journal") return this.memory.flushJournal();
    if (name === "posts") return this.agents.postSweep();
    return this.agents.sweep(name, { since });
  }
}
