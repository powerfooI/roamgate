import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ForgeRef, ForgeStatus } from "../../shared/forge";
import type { ConnectionClient } from "./api";
import {
  createForgeStore,
  FORGE_ERROR_MAX_MS,
  FORGE_ERROR_MS,
  FORGE_OPEN_MS,
  FORGE_RUNNING_MS,
  FORGE_SETTLED_MS,
  FORGE_UNAVAILABLE_MS,
  forgeRefreshDelay,
} from "./forgeStore";

const ref: ForgeRef = {
  provider: "gitlab",
  host: "gitlab.freedesktop.org",
  project: "gstreamer/gstreamer",
  number: 12855,
};

function ready(
  state: "open" | "merged" | "closed",
  pipeline: "running" | "pending" | "success" | "failed" | null,
): ForgeStatus {
  return {
    ref,
    state: "ready",
    fetchedAt: "",
    request: {
      url: "https://gitlab.freedesktop.org/gstreamer/gstreamer/-/merge_requests/12855",
      project: "gstreamer/gstreamer",
      title: "appsink",
      state,
      draft: false,
      author: "me",
      sourceBranch: "a",
      targetBranch: "main",
      updatedAt: "",
      pipeline: pipeline ? { status: pipeline, failed: [] } : null,
      approvals: null,
      unresolved: null,
    },
  };
}

function fakeClient(answers: (() => Promise<ForgeStatus>)[]) {
  const calls: { method: string; params: unknown; lane?: string }[] = [];
  let asked = 0;
  const client = {
    connectionId: "local",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (
      method: string,
      params: unknown,
      _timeout: unknown,
      options?: { lane?: string },
    ) => {
      calls.push({ method, params, lane: options?.lane });
      // Each answer in turn, then the last one again.
      const next = answers[Math.min(asked++, answers.length - 1)];
      if (!next) throw new Error("no answer");
      return next();
    },
  } as unknown as ConnectionClient;
  return { client, calls };
}

/** Lets awaited calls settle under fake timers. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("how often a request is asked again", () => {
  const entry = (status: ForgeStatus | null, failures = 0) => ({
    status,
    loading: false,
    failures,
  });
  test("follows what can still change", () => {
    expect(forgeRefreshDelay(entry(null))).toBe(0);
    expect(forgeRefreshDelay(entry(ready("open", "running")))).toBe(
      FORGE_RUNNING_MS,
    );
    expect(forgeRefreshDelay(entry(ready("open", "pending")))).toBe(
      FORGE_RUNNING_MS,
    );
    expect(forgeRefreshDelay(entry(ready("open", "success")))).toBe(
      FORGE_OPEN_MS,
    );
    expect(forgeRefreshDelay(entry(ready("merged", "running")))).toBe(
      FORGE_SETTLED_MS,
    );
    expect(forgeRefreshDelay(entry(ready("closed", null)))).toBe(
      FORGE_SETTLED_MS,
    );
    expect(
      forgeRefreshDelay(entry({ ref, state: "not_signed_in", fetchedAt: "" })),
    ).toBe(FORGE_UNAVAILABLE_MS);
    expect(
      forgeRefreshDelay(entry({ ref, state: "not_found", fetchedAt: "" })),
    ).toBe(FORGE_SETTLED_MS);
  });

  test("backs off after failures, up to a ceiling", () => {
    expect(forgeRefreshDelay(entry(null, 1))).toBe(FORGE_ERROR_MS);
    expect(forgeRefreshDelay(entry(null, 2))).toBe(FORGE_ERROR_MS * 2);
    expect(forgeRefreshDelay(entry(null, 3))).toBe(FORGE_ERROR_MS * 4);
    expect(forgeRefreshDelay(entry(ready("open", "running"), 30))).toBe(
      FORGE_ERROR_MAX_MS,
    );
  });
});

describe("the request cache", () => {
  test("asks only while shown, in the background lane, once for every chip", async () => {
    jest.useFakeTimers();
    const store = createForgeStore({ pageVisible: () => true });
    const { client, calls } = fakeClient([
      async () => ready("open", "success"),
    ]);
    const a = store.hold(client, ref, "w1");
    const b = store.hold(client, { ...ref, host: "GitLab.freedesktop.org" });
    expect(calls).toHaveLength(0);
    a.setVisible(true);
    b.setVisible(true);
    await settle();
    expect(calls).toEqual([
      {
        method: "forge.status",
        params: { ref, workspace_id: "w1" },
        lane: "background",
      },
    ]);
    expect(store.get(client, ref).status?.request?.state).toBe("open");
    a.release();
    b.release();
    store.clear();
  });

  test("follows a running pipeline until it finishes, then slows down", async () => {
    jest.useFakeTimers();
    const store = createForgeStore({ pageVisible: () => true });
    const answers = [
      async () => ready("open", "running"),
      async () => ready("open", "running"),
      async () => ready("open", "success"),
    ];
    const { client, calls } = fakeClient([...answers]);
    const held = store.hold(client, ref);
    held.setVisible(true);
    await settle();
    expect(calls).toHaveLength(1);
    jest.advanceTimersByTime(FORGE_RUNNING_MS);
    await settle();
    expect(calls).toHaveLength(2);
    jest.advanceTimersByTime(FORGE_RUNNING_MS);
    await settle();
    expect(calls).toHaveLength(3);
    expect(store.get(client, ref).status?.request?.pipeline?.status).toBe(
      "success",
    );
    // Passed: next in three minutes, not one.
    jest.advanceTimersByTime(FORGE_OPEN_MS - 1000);
    await settle();
    expect(calls).toHaveLength(3);
    jest.advanceTimersByTime(1000);
    await settle();
    expect(calls).toHaveLength(4);
    held.release();
    store.clear();
  });

  test("a merged request is left alone for six hours", async () => {
    jest.useFakeTimers();
    const store = createForgeStore({ pageVisible: () => true });
    const { client, calls } = fakeClient([async () => ready("merged", null)]);
    const held = store.hold(client, ref);
    held.setVisible(true);
    await settle();
    jest.advanceTimersByTime(FORGE_SETTLED_MS - 1000);
    await settle();
    expect(calls).toHaveLength(1);
    jest.advanceTimersByTime(1000);
    await settle();
    expect(calls).toHaveLength(2);
    held.release();
    store.clear();
  });

  test("a click on refresh asks the server not to answer from what it knows", async () => {
    jest.useFakeTimers();
    const store = createForgeStore({ pageVisible: () => true });
    const { client, calls } = fakeClient([
      async () => ready("open", "success"),
      async () => ready("open", "success"),
    ]);
    const held = store.hold(client, ref);
    held.setVisible(true);
    await settle();
    store.refresh(client, ref);
    await settle();
    expect(
      calls.map((call) => (call.params as { fresh?: boolean }).fresh),
    ).toEqual([undefined, true]);
    held.release();
    store.clear();
  });

  test("backs off on failures and keeps what it knew", async () => {
    jest.useFakeTimers();
    const store = createForgeStore({ pageVisible: () => true });
    let fail = false;
    const { client, calls } = fakeClient([
      async () => {
        if (fail) throw new Error("socket away");
        return ready("open", "success");
      },
    ]);
    const held = store.hold(client, ref);
    held.setVisible(true);
    await settle();
    fail = true;
    jest.advanceTimersByTime(FORGE_OPEN_MS);
    await settle();
    expect(calls).toHaveLength(2);
    expect(store.get(client, ref)).toMatchObject({
      failures: 1,
      status: { state: "ready" },
    });
    jest.advanceTimersByTime(FORGE_ERROR_MS);
    await settle();
    expect(calls).toHaveLength(3);
    // Twice as long the second time.
    jest.advanceTimersByTime(FORGE_ERROR_MS);
    await settle();
    expect(calls).toHaveLength(3);
    jest.advanceTimersByTime(FORGE_ERROR_MS);
    await settle();
    expect(calls).toHaveLength(4);
    held.release();
    store.clear();
  });

  test("a chip drawn again keeps what it showed and asks nothing", async () => {
    jest.useFakeTimers();
    const store = createForgeStore({ pageVisible: () => true });
    let answer: (status: ForgeStatus) => void = () => {};
    const { client, calls } = fakeClient([
      () => new Promise<ForgeStatus>((resolve) => (answer = resolve)),
    ]);
    const first = store.hold(client, ref);
    first.setVisible(true);
    await settle();
    expect(calls).toHaveLength(1);
    // Redrawn while the answer is on its way: no second question.
    first.release();
    const second = store.hold(client, ref);
    second.setVisible(true);
    await settle();
    expect(calls).toHaveLength(1);
    answer(ready("open", "running"));
    await settle();
    const known = store.get(client, ref);
    expect(known.status?.request?.state).toBe("open");
    // Redrawn once answered: the same entry, nothing asked, no loading.
    second.release();
    const third = store.hold(client, ref);
    third.setVisible(true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(store.get(client, ref)).toBe(known);
    // A refresh in flight keeps the status it had.
    jest.advanceTimersByTime(FORGE_RUNNING_MS);
    expect(calls).toHaveLength(2);
    expect(store.get(client, ref).loading).toBe(true);
    expect(store.get(client, ref).status).toBe(known.status);
    answer(ready("merged", null));
    await settle();
    expect(store.get(client, ref).status?.request?.state).toBe("merged");
    third.release();
    store.clear();
  });

  test("nothing is asked while off screen, or while the page is hidden", async () => {
    jest.useFakeTimers();
    let visible = false;
    const store = createForgeStore({ pageVisible: () => visible });
    const { client, calls } = fakeClient([
      async () => ready("open", "running"),
    ]);
    const held = store.hold(client, ref);
    held.setVisible(true);
    await settle();
    expect(calls).toHaveLength(0);
    visible = true;
    store.wake();
    await settle();
    expect(calls).toHaveLength(1);
    // Scrolled away: the running pipeline is not followed.
    held.setVisible(false);
    jest.advanceTimersByTime(FORGE_RUNNING_MS * 5);
    await settle();
    expect(calls).toHaveLength(1);
    // Back on screen, past due: asked at once.
    held.setVisible(true);
    await settle();
    expect(calls).toHaveLength(2);
    held.release();
    jest.advanceTimersByTime(FORGE_RUNNING_MS * 5);
    await settle();
    expect(calls).toHaveLength(2);
    store.clear();
  });
});
