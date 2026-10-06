// The heartbeat. Cheap ticks run often; expensive pi sweeps run on cadence
// during work hours only, and only while the laptop is awake (which is the
// whole limitation the cloud/ DO scaffold exists to lift later).

import type { Agents } from "./agents.ts";
import type { Checks } from "./checks.ts";
import { config, memoryOn, sweepOn } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { MemorySync } from "./memory-sync.ts";
import type { Prompter } from "./prompter.ts";

export class Scheduler {
  private timers: Timer[] = [];
  private last: Record<string, number> = {};

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
    // First pass shortly after boot.
    setTimeout(safe("boot", () => this.boot()), 500);
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  private async boot() {
    if (memoryOn()) await this.memory.importAll().catch((e) => console.error("[memory]", e.message));
    this.prompter.tick();
    this.last.memory = Date.now();
    if (config.sweeps.enabled && this.inWorkHours()) {
      if (sweepOn("calendar")) void this.agents.sweep("calendar");
      this.last.calendar = Date.now();
      // Stagger: transcripts a minute later so two cold pi starts don't collide.
      if (sweepOn("transcripts")) setTimeout(() => void this.agents.sweep("transcripts"), 60_000);
      this.last.transcripts = Date.now();
    }
  }

  inWorkHours(now = new Date()) {
    const [a, b] = config.sweeps.workHours;
    const h = now.getHours();
    return now.getDay() !== 0 && now.getDay() !== 6 && h >= a && h < b;
  }

  private due(name: string, everyMin: number) {
    return Date.now() - (this.last[name] ?? 0) >= everyMin * 60_000;
  }

  private async cadence() {
    if (this.due("cmuxPrune", 10)) {
      this.last.cmuxPrune = Date.now();
      this.agents.pruneCmux();
    }
    if (this.due("journal", config.memory.flushEveryMin) && memoryOn()) {
      this.last.journal = Date.now();
      await this.memory.flushJournal().catch((e) => console.error("[journal]", e.message));
    }
    if (this.due("memory", config.memory.importEveryMin) && memoryOn()) {
      this.last.memory = Date.now();
      await this.memory.importAll().catch((e) => console.error("[memory]", e.message));
    }
    if (!config.sweeps.enabled || !this.inWorkHours()) return;
    // Cheap shell checks, once per workday, ahead of the morning plan.
    if (this.checks && sweepOn("checks")) void this.checks.runDue().catch((e) => console.error("[checks]", e.message));
    if (sweepOn("calendar") && this.due("calendar", config.sweeps.calendarEveryMin)) {
      this.last.calendar = Date.now();
      void this.agents.sweep("calendar");
    }
    if (sweepOn("transcripts") && this.due("transcripts", config.sweeps.transcriptsEveryMin)) {
      this.last.transcripts = Date.now();
      void this.agents.sweep("transcripts");
    }
    // Writing scout: weekly, persisted in sync state so restarts don't re-run it. Retry a failure after 6h.
    const posts = this.hub.store.syncState("posts");
    const age = (iso?: string) => (iso ? Date.now() - Date.parse(iso) : Infinity);
    if (sweepOn("posts") && config.sweeps.postsEveryDays > 0 && age(posts.lastOkAt) > config.sweeps.postsEveryDays * 86400_000 && age(posts.lastRunAt) > 6 * 3600_000 && new Date().getHours() >= 10) {
      void this.agents.postSweep();
    }
  }

  /** Manual trigger from the UI. */
  async run(name: "memory" | "journal" | "calendar" | "transcripts" | "posts", since?: string) {
    this.last[name] = Date.now();
    if (name === "memory") return this.memory.importAll();
    if (name === "journal") return this.memory.flushJournal();
    if (name === "posts") return this.agents.postSweep();
    return this.agents.sweep(name, { since });
  }
}
