import { afterEach, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSeenStore,
  createAgentSeenStore as openStore,
  createHerdrBootCache,
  markAgentSeen,
} from "./agent-seen";

const directories: string[] = [];
const stores: AgentSeenStore[] = [];
// Pending writes go out before their directory is removed.
const createAgentSeenStore = (...args: Parameters<typeof openStore>) => {
  const store = openStore(...args);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.flush();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function path() {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-seen-"));
  directories.push(directory);
  return join(directory, "agent-seen.json");
}
const agent = (status: string, seq: number, pane = "w1:p1") => ({
  pane_id: pane,
  terminal_id: `term-${pane}`,
  agent: "claude",
  agent_status: status,
  state_change_seq: seq,
});

test("an agent is Done when it changed state since it was seen", () => {
  const store = createAgentSeenStore(path());
  const list = {
    agents: [agent("idle", 5), agent("done", 3, "w1:p2"), agent("working", 9)],
  };
  // Never seen in Roamgate: Herdr's states stay.
  expect(store.annotate("local", list)).toEqual(list);
  expect(store.mark("local", "w1:p1", "term-w1:p1", 4)).toBe(true);
  expect(store.mark("local", "w1:p2", "term-w1:p2", 3)).toBe(true);
  const annotated = store.annotate("local", list) as {
    agents: Record<string, unknown>[];
  };
  // Finished after it was seen (Herdr says idle): Done.
  expect(annotated.agents[0]!.seen_done).toBe(true);
  // Herdr says done, but it was seen in this state: not Done.
  expect(annotated.agents[1]!.seen_done).toBe(false);
  // Working agents are not judged.
  expect(annotated.agents[2]!.seen_done).toBeUndefined();
  // Each look is dated.
  expect(annotated.agents[0]!.seen_at).toEqual(expect.any(Number));
  // Another connection's marks are its own.
  expect(store.annotate("desktop", list)).toEqual(list);
});

test("marks only move forward on one Herdr boot, and survive a restart", () => {
  const file = path();
  const store = createAgentSeenStore(file);
  const boot = "1072-1792889171298769000";
  expect(store.mark("local", "w1:p1", "t1", 7, boot)).toBe(true);
  // A late report from another device on the same server.
  expect(store.mark("local", "w1:p1", "t1", 6, boot)).toBe(false);
  expect(store.mark("local", "w1:p1", "t1", 7, boot)).toBe(false);
  // A look while it works keeps what was seen finished.
  expect(store.mark("local", "w1:p1", "t1", undefined, boot)).toBe(false);
  expect(store.mark("local", "w1:p1", "t1")).toBe(false);
  expect(store.seen("local", "w1:p1", "t1")).toBe(7);
  expect(store.mark("local", "w1:p1", "t1", -1)).toBe(false);
  // A new agent in the same pane is another terminal: not seen yet.
  expect(store.seen("local", "w1:p1", "t2")).toBeNull();
  store.flush();
  expect(createAgentSeenStore(file).seen("local", "w1:p1", "t1")).toBe(7);
});

test("a damaged file forgets what was seen rather than failing", () => {
  const file = path();
  writeFileSync(file, "{ not json");
  const store = createAgentSeenStore(file);
  expect(store.seen("local", "w1:p1", "t1")).toBeNull();
  expect(store.mark("local", "w1:p1", "t1", 1)).toBe(true);
});

test("an agent looked at while working is Done once it finishes", () => {
  let clock = 1000;
  const store = createAgentSeenStore(path(), () => clock);
  store.mark("local", "w1:p1", "term-w1:p1");
  expect(store.seen("local", "w1:p1", "term-w1:p1")).toBe(-1);
  clock = 2000;
  const annotated = store.annotate("local", {
    agents: [agent("idle", 0), agent("working", 4, "w1:p2")],
  }) as { agents: Record<string, unknown>[] };
  expect(annotated.agents[0]).toMatchObject({ seen_done: true, seen_at: 1000 });
  expect(annotated.agents[1]!.seen_at).toBeUndefined();
});

test("a Herdr restart forgets the marks of the server before", () => {
  const file = path();
  const store = createAgentSeenStore(file);
  const before = "1072-1792889171298769000";
  const after = "2210-1792990000000000000";
  // Seen finished late in the first server's life.
  expect(store.mark("local", "w1:p1", "term-w1:p1", 1800, before)).toBe(true);
  // The agent lives through a handoff with its terminal id, and Herdr counts
  // again from zero: its next turns are Done, not hidden below 1800.
  const list = { agents: [agent("done", 12)] };
  const annotate = (boot?: string | null) =>
    (store.annotate("local", list, boot) as { agents: object[] }).agents[0];
  // Another boot: never seen there.
  expect(annotate(after)).toEqual(agent("done", 12));
  // Boot unknown (legacy Herdr): a number below the mark says the same.
  expect(annotate(null)).toEqual(agent("done", 12));
  expect(annotate(undefined)).toEqual(agent("done", 12));
  // Seen on the new server: a lower number replaces the old mark.
  expect(store.mark("local", "w1:p1", "term-w1:p1", 12, after)).toBe(true);
  expect(store.seen("local", "w1:p1", "term-w1:p1")).toBe(12);
  expect(annotate(after)).toMatchObject({ seen_done: false });
  expect(
    (
      store.annotate("local", { agents: [agent("idle", 15)] }, after) as {
        agents: object[];
      }
    ).agents[0],
  ).toMatchObject({ seen_done: true });
  // The boot is kept across a Roamgate restart.
  store.flush();
  const reloaded = createAgentSeenStore(file);
  expect(reloaded.seen("local", "w1:p1", "term-w1:p1")).toBe(12);
  expect(
    (reloaded.annotate("local", list, before) as { agents: object[] })
      .agents[0],
  ).toEqual(agent("done", 12));
});

test("without a boot id a lower state number is a Herdr restart", () => {
  const store = createAgentSeenStore(path());
  expect(store.mark("local", "w1:p1", "t1", 900)).toBe(true);
  expect(store.mark("local", "w1:p1", "t1", 3)).toBe(true);
  expect(store.seen("local", "w1:p1", "t1")).toBe(3);
  // A look while working on a new boot starts over too.
  expect(store.mark("local", "w1:p1", "t1", undefined, "b2")).toBe(false);
  expect(store.mark("local", "w1:p1", "t1", 5, "b3")).toBe(true);
  expect(store.mark("local", "w1:p1", "t1", undefined, "b4")).toBe(false);
  expect(store.seen("local", "w1:p1", "t1")).toBe(-1);
});

test("the boot id is read once a minute, or again when invalidated", async () => {
  let clock = 0;
  const cache = createHerdrBootCache(() => clock);
  let reads = 0;
  const read = async () => `boot-${++reads}`;
  expect(await cache.get("local", read)).toBe("boot-1");
  expect(await cache.get("local", read)).toBe("boot-1");
  clock = 60_000;
  expect(await cache.get("local", read)).toBe("boot-2");
  cache.invalidate("local");
  expect(await cache.get("local", read)).toBe("boot-3");
  // Failures and empty ids are unknown boots, not errors.
  cache.invalidate("local");
  expect(
    await cache.get("local", () => Promise.reject(new Error("closed"))),
  ).toBeNull();
  cache.invalidate("local");
  expect(await cache.get("local", async () => "")).toBeNull();
});

test("marks are written once per burst, and at once on flush", () => {
  jest.useFakeTimers();
  try {
    const file = path();
    const store = createAgentSeenStore(file);
    store.mark("local", "w1:p1", "t1", 1);
    store.mark("local", "w1:p2", "t2", 2);
    expect(existsSync(file)).toBe(false);
    jest.advanceTimersByTime(999);
    expect(existsSync(file)).toBe(false);
    jest.advanceTimersByTime(1);
    expect(createAgentSeenStore(file).seen("local", "w1:p2", "t2")).toBe(2);
    store.mark("local", "w1:p3", "t3", 3);
    // Shutdown does not wait for the timer.
    store.flush();
    expect(createAgentSeenStore(file).seen("local", "w1:p3", "t3")).toBe(3);
    // Nothing pending: nothing written, and the timer is gone.
    rmSync(file);
    store.flush();
    jest.advanceTimersByTime(5_000);
    expect(existsSync(file)).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("connections looked at longest ago are forgotten beyond 64", () => {
  let clock = 0;
  const store = createAgentSeenStore(path(), () => clock);
  for (let index = 0; index < 64; index++) {
    clock = index;
    store.mark(`c${index}`, "w1:p1", "t1", 1);
  }
  // The first connection looks again: the second is now the oldest.
  clock = 100;
  store.mark("c0", "w1:p1", "t1", 2);
  clock = 101;
  store.mark("c64", "w1:p1", "t1", 1);
  expect(store.seen("c64", "w1:p1", "t1")).toBe(1);
  expect(store.seen("c0", "w1:p1", "t1")).toBe(2);
  expect(store.seen("c1", "w1:p1", "t1")).toBeNull();
  expect(store.seen("c2", "w1:p1", "t1")).toBe(1);
  store.flush();
});

test("agent_seen.mark checks its parameters and marks on the current boot", async () => {
  const store = createAgentSeenStore(path());
  const boots = createHerdrBootCache();
  let boot = "boot-1";
  let reads = 0;
  const readBoot = async () => {
    reads++;
    return boot;
  };
  const mark = (params: unknown) =>
    markAgentSeen(store, boots, "local", params, readBoot);
  for (const params of [
    undefined,
    null,
    "w1:p1",
    {},
    { pane_id: "w1:p1" },
    { pane_id: "", terminal_id: "t1" },
    { pane_id: "w1:p1", terminal_id: "" },
    { pane_id: "w1:p1", terminal_id: 7 },
    { pane_id: "x".repeat(201), terminal_id: "t1" },
    { pane_id: "w1:p1", terminal_id: "t".repeat(201) },
    { pane_id: "w1:p1", terminal_id: "t1", seq: "4" },
  ])
    await expect(mark(params)).rejects.toThrow("invalid agent_seen.mark");
  expect(reads).toBe(0);
  expect(await mark({ pane_id: "w1:p1", terminal_id: "t1", seq: 40 })).toEqual({
    marked: true,
  });
  expect(await mark({ pane_id: "w1:p1", terminal_id: "t1", seq: 40 })).toEqual({
    marked: false,
  });
  // A look while working.
  expect(await mark({ pane_id: "w1:p2", terminal_id: "t2" })).toEqual({
    marked: false,
  });
  expect(store.seen("local", "w1:p2", "t2")).toBe(-1);
  // Invalid numbers are not marks.
  expect(await mark({ pane_id: "w1:p1", terminal_id: "t1", seq: -2 })).toEqual({
    marked: false,
  });
  // The boot id was read once, then cached.
  expect(reads).toBe(1);
  // Herdr restarted: a lower number reads the boot id again, so the mark is
  // made on the new boot rather than dropped as a late one.
  boot = "boot-2";
  expect(await mark({ pane_id: "w1:p1", terminal_id: "t1", seq: 3 })).toEqual({
    marked: true,
  });
  expect(reads).toBe(2);
  expect(store.seen("local", "w1:p1", "t1")).toBe(3);
});
