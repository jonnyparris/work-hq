// Machine load over time. Nothing used to log it, so "does load still follow the number of running
// agents?" (after test-lock and RunCap, 10-22) could only be answered from one live `uptime`.
// The scheduler samples os.loadavg() once a minute into the `load` table (8 days kept), next to
// the number of action jobs running then. GET /api/load and `bin/work-hq usage` read it back; the Agents panel shows the latest sample. `pi.maxLoad` (RunCap) holds launches
// while the 1-minute load is above it.

import { cpus, loadavg } from "node:os";
import type { LoadNow } from "../shared/types.ts";

export type { LoadNow };

/** [epoch ms, 1-min, 5-min, 15-min load, action jobs running]. Compact: 1440 of these is ~50 KB. */
export type LoadSample = [t: number, l1: number, l5: number, l15: number, jobs: number];

export interface LoadSummary {
  samples: number;
  from?: string;
  to?: string;
  cores: number;
  meanL1: number;
  peak?: { at: string; l1: number; jobs: number };
  /** Samples with the 1-min load above the core count. */
  overCores: number;
  /** Pearson r between running jobs and 1-min load. Undefined with < 10 samples or no spread. */
  r?: number;
  /** Mean 1-min load by running-job count, so the shape shows (not just r). */
  byJobs: Array<{ jobs: number; n: number; meanL1: number }>;
}

const round = (n: number) => Math.round(n * 100) / 100;
const CORES = cpus().length || 1;
export const cores = () => CORES;

/** Live 1-minute load is above `max` (0 or less = never). */
export function overloaded(max: number, read: () => number[] = loadavg) {
  return max > 0 && (read()[0] ?? 0) > max;
}

/** Where samples live: the store's `load` table (Store.loadSamples / putLoad). */
export interface LoadStore {
  loadSamples(sinceMs?: number): LoadSample[];
  putLoad(s: LoadSample, keepSinceMs: number): void;
}

/** A rolling window of samples (8 days by default: enough to judge a week), surviving restarts. */
export class LoadLog {
  constructor(
    private store: LoadStore,
    private keepMs = 8 * 86400_000,
    private read: () => number[] = loadavg,
  ) {}

  samples(sinceMs = 0): LoadSample[] {
    return this.store.loadSamples(sinceMs);
  }

  /** Take one sample now and drop the ones older than the window. */
  record(jobs: number, now = Date.now()): LoadSample {
    const [l1 = 0, l5 = 0, l15 = 0] = this.read();
    const s: LoadSample = [now, round(l1), round(l5), round(l15), jobs];
    this.store.putLoad(s, now - this.keepMs);
    return s;
  }

  latest(): LoadSample | undefined {
    return this.store.loadSamples(Date.now() - 5 * 60_000).at(-1);
  }
}

export function loadNow(s: LoadSample, max: number, n = cores()): LoadNow {
  return { at: new Date(s[0]).toISOString(), l1: s[1], l5: s[2], l15: s[3], jobs: s[4], cores: n, max };
}

export function summarise(samples: LoadSample[], n = cores()): LoadSummary {
  const out: LoadSummary = { samples: samples.length, cores: n, meanL1: 0, overCores: 0, byJobs: [] };
  if (!samples.length) return out;
  out.from = new Date(samples[0]![0]).toISOString();
  out.to = new Date(samples.at(-1)![0]).toISOString();
  const l1 = samples.map((s) => s[1]);
  const jobs = samples.map((s) => s[4]);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  out.meanL1 = round(mean(l1));
  out.overCores = l1.filter((l) => l > n).length;
  const peak = samples.reduce((a, b) => (b[1] > a[1] ? b : a));
  out.peak = { at: new Date(peak[0]).toISOString(), l1: peak[1], jobs: peak[4] };
  if (samples.length >= 10) {
    const mj = mean(jobs);
    const ml = mean(l1);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < samples.length; i++) {
      const dx = jobs[i]! - mj;
      const dy = l1[i]! - ml;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    if (sxx > 0 && syy > 0) out.r = round(sxy / Math.sqrt(sxx * syy));
  }
  const by = new Map<number, number[]>();
  for (const s of samples) by.set(s[4], [...(by.get(s[4]) ?? []), s[1]]);
  out.byJobs = [...by].sort((a, b) => a[0] - b[0]).map(([j, ls]) => ({ jobs: j, n: ls.length, meanL1: round(mean(ls)) }));
  return out;
}
