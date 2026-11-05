// GitLab "Merged" isn't "landed". On a fast-forward project, merging a branch that's behind its target can push
// nothing and still read Merged (api-worker !1691 10-24, !1723 10-26). Null merge/squash SHAs aren't the
// tell either: rebase-on-merge leaves both null on every good merge too. Landed = the code is on the target.
import { beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/db.ts";
import { Hub } from "../src/server/hub.ts";
import { JiraStates } from "../src/server/jira-state.ts";
import { fetchMr, type GitLabGet, type MrInfo, MrStates, parseMrRef } from "../src/server/mr-state.ts";
import { PrStates } from "../src/server/pr-state.ts";
import { Prompter } from "../src/server/prompter.ts";

const MR = "https://gitlab.example.org/acme/api-worker/-/merge_requests/1691";
const ref = parseMrRef(MR)!;
const P = "projects/acme%2Fapi-worker";
const MERGED_AT = "2026-10-24T21:46:27.932Z";
const mr = (o: Record<string, unknown> = {}) => ({ state: "merged", merged_at: MERGED_AT, merge_commit_sha: null, squash_commit_sha: null, sha: "head1", target_branch: "staging", ...o });
const commits = [
  { id: "a", title: "PAY-1799: docs: Node-only setup", authored_date: "2026-10-19T09:00:00.000+00:00", parent_ids: ["p"] },
  { id: "b", title: "PAY-1799: docs: DevTools port", authored_date: "2026-10-19T10:00:00.000+01:00", parent_ids: ["a"] },
  { id: "m", title: "Merge origin/staging into PAY-1799", authored_date: "2026-10-23T08:00:00.000+00:00", parent_ids: ["b", "s"] },
];

/** A stub GitLab: answers by path prefix, records every path asked. */
function gitlab(over: { mr?: unknown; base?: unknown; commits?: unknown; target?: unknown[] | undefined; project?: unknown } = {}) {
  const calls: string[] = [];
  const get: GitLabGet = async (_r, path) => {
    calls.push(path);
    if (path === `${P}/merge_requests/1691`) return "mr" in over ? over.mr : mr();
    if (path.startsWith(`${P}/repository/merge_base?`)) return "base" in over ? over.base : { id: "other" };
    if (path.startsWith(`${P}/merge_requests/1691/commits`)) return "commits" in over ? over.commits : commits;
    if (path.startsWith(`${P}/repository/commits?`)) return "target" in over ? over.target : [];
    if (path === P) return "project" in over ? over.project : { default_branch: "staging" };
    return undefined;
  };
  return { get, calls };
}

test("merged, both SHAs null, no commit on the target → merged-not-landed", async () => {
  const g = gitlab({ target: [{ id: "x", title: "someone else's commit" }] });
  const info = await fetchMr(ref, g.get);
  expect(info).toEqual({ state: "merged-not-landed", mergedAt: MERGED_AT, landing: "0 of 2 commits on staging" });
  // The merge-commit "Merge origin/staging…" isn't one to look for.
  expect(g.calls.some((c) => c.includes("since=2026-10-24T21:31:27.932Z") && c.includes("ref_name=staging"))).toBe(true);
});

test("merged, both SHAs null, every commit title on the target (rebase on merge) → merged", async () => {
  const g = gitlab({ target: commits.slice(0, 2).map((c) => ({ ...c, id: `${c.id}-rebased` })) });
  expect(await fetchMr(ref, g.get)).toEqual({ state: "merged", mergedAt: MERGED_AT });
  // Found in the merge window: no second window.
  expect(g.calls.filter((c) => c.includes("/repository/commits?"))).toHaveLength(1);
});

test("same title, different author date: someone else's commit doesn't count", async () => {
  const g = gitlab({ target: [{ ...commits[0]!, id: "x", authored_date: "2026-10-24T21:40:00Z" }, { ...commits[1]!, id: "y", authored_date: "2026-10-19T10:00:00Z" }] });
  expect(await fetchMr(ref, g.get)).toMatchObject({ state: "merged-not-landed", landing: "0 of 2 commits on staging" });
  // Same instant in another zone is the same commit.
  const ok = gitlab({ target: [{ ...commits[0]!, id: "x", authored_date: "2026-10-19T09:00:00Z" }, { ...commits[1]!, id: "y", authored_date: "2026-10-19T09:00:00Z" }] });
  expect((await fetchMr(ref, ok.get)).state).toBe("merged");
});

test("MR commits without a (readable) author date match on title alone", async () => {
  const bare = [{ ...commits[0]!, authored_date: undefined }, { ...commits[1]!, authored_date: "garbage" }];
  const target = [{ id: "x", title: commits[0]!.title, authored_date: "2026-10-24T21:46:00Z" }, { id: "y", title: commits[1]!.title, authored_date: "2026-10-24T21:46:00Z" }];
  expect((await fetchMr(ref, gitlab({ commits: bare, target }).get)).state).toBe("merged");
});

test("commits already on the target before the merge (merge main into staging) → merged", async () => {
  const g = gitlab();
  const get: GitLabGet = async (r, path) => {
    if (!path.includes("/repository/commits?")) return g.get(r, path);
    // Only the window that reaches back to the oldest author date (10-19 09:00Z, less a minute) has them.
    return path.includes("since=2026-10-19T08:59:00.000Z") ? commits.slice(0, 2) : [];
  };
  expect((await fetchMr(ref, get)).state).toBe("merged");
});

test("an MR with over 100 commits: every page is matched; over 500 is unknown", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, title: `commit ${i}`, parent_ids: ["p"] }));
  const g = gitlab({ target: many.slice(0, 99) });
  const get: GitLabGet = async (r, path) => (path.includes("/merge_requests/1691/commits") ? (path.endsWith("page=1") ? many.slice(0, 100) : many.slice(100)) : g.get(r, path));
  expect(await fetchMr(ref, get)).toMatchObject({ state: "merged-not-landed", landing: "99 of 150 commits on staging" });
  const huge: GitLabGet = async (r, path) => (path.includes("/merge_requests/1691/commits") ? many.slice(0, 100) : g.get(r, path));
  expect(await fetchMr(ref, huge)).toMatchObject({ state: "unknown", landing: "landing check failed: MR has 500+ commits" });
});

test("relanded later: titles show up after the merge window → merged", async () => {
  let n = 0;
  const g = gitlab();
  const get: GitLabGet = async (r, path) => (path.includes("/repository/commits?") ? (n++ === 0 ? [] : commits.slice(0, 2)) : g.get(r, path));
  expect((await fetchMr(ref, get)).state).toBe("merged");
  expect(n).toBe(2);
});

test("some titles on the target → merged-not-landed, says how many", async () => {
  const g = gitlab({ target: [commits[0]] });
  expect(await fetchMr(ref, g.get)).toMatchObject({ state: "merged-not-landed", landing: "1 of 2 commits on staging" });
});

test("a merge or squash commit, or a head on the target, → merged with no commit scan", async () => {
  for (const o of [{ merge_commit_sha: "mc" }, { squash_commit_sha: "sq" }]) {
    const g = gitlab({ mr: mr(o) });
    expect(await fetchMr(ref, g.get)).toEqual({ state: "merged", mergedAt: MERGED_AT });
    expect(g.calls).toHaveLength(1);
  }
  // The head on the target settles it even when the project lookup would fail.
  const g = gitlab({ base: { id: "head1" }, project: undefined });
  expect((await fetchMr(ref, g.get)).state).toBe("merged");
  expect(g.calls.some((c) => c.includes("/commits"))).toBe(false);
});

test("stacked: merged into a non-default branch → merged (the parent MR carries the check)", async () => {
  const g = gitlab({ mr: mr({ target_branch: "alice/parent" }) });
  expect((await fetchMr(ref, g.get)).state).toBe("merged");
  // Decided before any commit lookup.
  expect(g.calls.map((c) => c.split("?")[0])).toEqual([`${P}/merge_requests/1691`, `${P}/repository/merge_base`, P]);
});

test("open, closed and failed lookups don't run the landing check; a failure mid-check is unknown, never landed", async () => {
  for (const state of ["opened", "closed"]) {
    const g = gitlab({ mr: mr({ state }) });
    expect((await fetchMr(ref, g.get)).state).toBe(state as MrInfo["state"]);
    expect(g.calls).toHaveLength(1);
  }
  expect((await fetchMr(ref, gitlab({ mr: undefined }).get)).state).toBe("unknown");
  expect(await fetchMr(ref, gitlab({ commits: undefined }).get)).toMatchObject({ state: "unknown", landing: "landing check failed: MR commits" });
  expect((await fetchMr(ref, gitlab({ target: undefined }).get)).state).toBe("unknown");
  expect((await fetchMr(ref, gitlab({ project: undefined }).get)).state).toBe("unknown");
  expect(await fetchMr(ref, gitlab({ commits: [] }).get)).toMatchObject({ state: "unknown", landing: "landing check failed: MR lists no commits" });
  // A failed head-SHA check isn't a failure: a rebased head is on no branch, a GC'd one 404s. The titles decide.
  expect((await fetchMr(ref, gitlab({ base: undefined, target: commits.slice(0, 2) }).get)).state).toBe("merged");
  // Only merge commits: nothing to match, not a false alarm.
  expect((await fetchMr(ref, gitlab({ commits: [commits[2]] }).get)).state).toBe("merged");
});

test("a busy target branch: the scan stops at the page cap and says unknown rather than guess", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, title: `other ${i}` }));
  const g = gitlab({ target: full });
  const info = await fetchMr(ref, g.get);
  expect(info.state).toBe("unknown");
  expect(info.landing).toMatch(/stopped after 2000 staging commits/);
  expect(g.calls.filter((c) => c.includes("/repository/commits?"))).toHaveLength(20);
});

test("out of time: every lookup after the MR read checks the budget, and the answer is unknown", async () => {
  expect(await fetchMr(ref, gitlab().get, -1)).toMatchObject({ state: "unknown", landing: "landing check failed: out of time after 0 landing lookups" });
  // Mid-scan: the budget runs out while the MR commits load.
  const g = gitlab();
  const slow: GitLabGet = async (r, path) => {
    if (path.includes("/merge_requests/1691/commits")) await Bun.sleep(30);
    return g.get(r, path);
  };
  expect(await fetchMr(ref, slow, 20)).toMatchObject({ state: "unknown", landing: "landing check failed: out of time after 3 landing lookups" });
});

test("the item's case: glab says merged with both SHAs null and nothing landed → verdict undefined", async () => {
  const mrs = new MrStates(() => fetchMr(ref, gitlab().get));
  const it = { links: [MR], source: { type: "memory" as const } };
  expect(mrs.verdict(it)).toBe("pending");
  await mrs.settled();
  expect(mrs.verdict(it)).toBeUndefined();
  expect(mrs.notLanded(it)).toEqual([{ ...ref, landing: "0 of 2 commits on staging" }]);
  expect(mrs.failed(it)).toBe(0);
});

// Recheck: a merged-not-landed item stays off the "landed" picks and is listed apart.
let states: Record<string, MrInfo>;
let hub: Hub;
let p: Prompter;
const mrUrl = (n: number) => `https://gitlab.example.org/acme/api-worker/-/merge_requests/${n}`;

beforeEach(() => {
  states = {
    [mrUrl(1)]: { state: "merged", mergedAt: "2026-10-27T10:00:00Z" },
    [mrUrl(2)]: { state: "merged-not-landed", mergedAt: "2026-10-26T11:27:23Z", landing: "0 of 9 commits on staging" },
  };
  hub = new Hub(new Store(":memory:"));
  p = new Prompter(hub, new MrStates(async (r) => states[r.url] ?? { state: "unknown" }), new JiraStates(async () => ({ state: "unknown" }), new Set()), new PrStates(async () => ({ state: "unknown" })));
});

test("Recheck: merged-not-landed isn't on the landed list or the picks; it's listed apart on the card", async () => {
  const good = hub.createItem({ title: "Landed one", status: "waiting", links: [mrUrl(1)] });
  const bad = hub.createItem({ title: "Boot bundle", status: "waiting", links: [mrUrl(2)] });
  const r = await p.recheck();
  expect(r.landed.map((x) => x.id)).toEqual([good.id]);
  expect(r.notLanded).toEqual([{ id: bad.id, title: "Boot bundle", status: "waiting", line: "api-worker!2 merged, not on target (0 of 9 commits on staging)." }]);
  expect(r.failed).toBe(0);
  const q = hub.store.openQuestionByKey("recheck")!;
  expect(q.picks!.map((x) => x.id)).toEqual([good.id]);
  expect(q.context).toMatch(/Merged, not on target \(not done: reland them\):\n- Boot bundle \(api-worker!2 merged, not on target/);
  expect(hub.store.syncState("recheck").cursor).toBe("2 checked · 1 landed · 1 merged, not on target");
  // Mark all done leaves the unlanded one alone.
  await hub.answer(q.id, "all");
  expect(hub.store.item(good.id)!.status).toBe("done");
  expect(hub.store.item(bad.id)!.status).toBe("waiting");
});

test("Recheck: an item with one landed MR and one merged-not-landed MR isn't landed", async () => {
  const it = hub.createItem({ title: "Two MRs", status: "waiting", links: [mrUrl(1), mrUrl(2)] });
  const r = await p.recheck();
  expect(r.landed).toEqual([]);
  expect(r.notLanded.map((x) => x.id)).toEqual([it.id]);
  expect(hub.store.openQuestionByKey("recheck")).toBeUndefined();
});
