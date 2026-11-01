import { describe, expect, spyOn, test } from "bun:test";
import { createAgentSessionHandlers } from "./agent-sessions";
import type { AgentSessionFileAccess } from "./session-file-access";
import {
  createSessionProjectionCache,
  estimateRetainedBytes,
} from "./session-projection-cache";
import type { AgentSessionResolved, SessionFile } from "./session-types";
import type { HistoryUpdate } from "./session-history";

function fixture(agent = "pi") {
  const path = "/tmp/history-test.jsonl";
  let text = "";
  let file: SessionFile | null = {
    path,
    mtimeMs: 1000,
    size: 0,
    identity: "1",
    changeToken: "1",
  };
  let reads = 0;
  let onRead: (() => void) | undefined;
  const files: AgentSessionFileAccess = {
    remote: true,
    async statFile() {
      return file && { ...file };
    },
    async readText() {
      reads++;
      const result = text;
      onRead?.();
      return result;
    },
    async readPrefix(_path, limit) {
      return Buffer.from(text).subarray(0, limit);
    },
    async readDownloadBody() {
      return text;
    },
    async findPiSessionById() {
      return file;
    },
    async findClaudeSessionById() {
      return file;
    },
    async findClaudeSuccessor() {
      return null;
    },
    async findCodexSessionById() {
      return file;
    },
  };
  const herdrCall = async () => ({
    agent: { agent, agent_session: { kind: "path", value: path } },
  });
  const handlers = createAgentSessionHandlers({ files, herdrCall });
  const history = async (cursor?: unknown) => {
    const result = await handlers.readHistory({
      pane_id: "p",
      history_version: 2,
      cursor,
    });
    if (!("history_version" in result)) throw new Error("Expected version 2");
    return result;
  };
  const resolved: AgentSessionResolved = {
    version: 1,
    agent,
    pane_id: "p",
    workspace_id: "w",
    tab_id: "t",
    status: "ok",
    detail: "",
    updated_at: "",
    path,
    session: { kind: "path", value: path, source: "test", agent },
    file,
  };
  return {
    files,
    handlers,
    history,
    resolved,
    herdrCall,
    get reads() {
      return reads;
    },
    setReadHook(hook?: () => void) {
      onRead = hook;
    },
    missing() {
      file = null;
    },
    set(
      records: unknown[],
      options: { identity?: string; tail?: string } = {},
    ) {
      text =
        records.map((record) => JSON.stringify(record)).join("\n") +
        "\n" +
        (options.tail ?? "");
      file = {
        path,
        mtimeMs: (file?.mtimeMs ?? 1000) + 1,
        size: Buffer.byteLength(text),
        identity: options.identity ?? file?.identity ?? "1",
        changeToken: String(Number(file?.changeToken ?? 0) + 1),
      };
      resolved.file = file;
    },
  };
}
const message = (text: string) => ({
  type: "message",
  timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content: [{ type: "text", text }] },
});
function snapshot(update: HistoryUpdate) {
  if (update.mode !== "snapshot") throw new Error("Expected snapshot");
  return update;
}
function delta(update: HistoryUpdate) {
  if (update.mode !== "delta") throw new Error("Expected delta");
  return update;
}

describe("bounded cache payload estimation", () => {
  test("counts nested strings, arguments and repeated revision values", () => {
    const value = {
      arguments: { command: "x".repeat(1024), flags: [true, null, 1] },
      extra: { detail: "y".repeat(2048) },
    };
    const bytes = estimateRetainedBytes(value, Infinity);
    expect(bytes).toBeGreaterThan(2 * (1024 + 2048));
    expect(estimateRetainedBytes(value, bytes)).toBe(bytes);
    expect(estimateRetainedBytes(value, bytes - 1)).toBe(Infinity);
    expect(estimateRetainedBytes([value, value], Infinity)).toBeGreaterThan(
      2 * bytes,
    );
  });

  test("stops before visiting the remaining payload once over budget", () => {
    const value: unknown[] = ["x".repeat(1000), null];
    Object.defineProperty(value, "1", {
      get() {
        throw new Error("Visited payload after budget was exceeded");
      },
    });
    expect(estimateRetainedBytes(value, 100)).toBe(Infinity);
  });

  test("deep payloads are not admitted instead of overflowing the call stack", () => {
    let value: unknown = "leaf";
    for (let depth = 0; depth < 100; depth++) value = { nested: value };
    expect(estimateRetainedBytes(value, 32 * 1024 * 1024)).toBe(Infinity);
  });
});

describe("session projection cache and history revisions", () => {
  test("coalesces history, summary, preview and ATIF; unchanged refresh never reads again", async () => {
    const f = fixture();
    f.set([message("hello")]);
    const [first, summary, atif] = await Promise.all([
      f.history(),
      f.handlers.readSummary({
        pane_id: "p",
        include_trajectory: true,
        include_text: true,
      }),
      f.handlers.downloadAtif({ pane_id: "p" }),
    ]);
    expect(f.reads).toBe(1);
    expect(summary.stats.turns).toBe(1);
    expect(summary.text).toContain("hello");
    expect((await atif.json()).steps).toHaveLength(1);
    const refresh = delta(await f.history(first.cursor));
    expect(refresh.upserts).toEqual([]);
    expect(refresh.removed).toEqual([]);
    expect(refresh.order).toBeUndefined();
    expect(refresh.cursor).toEqual(first.cursor);
    expect(refresh).not.toHaveProperty("messages");
    expect(refresh).not.toHaveProperty("entries");
    expect(refresh).not.toHaveProperty("trajectory");
    await f.handlers.readSummary({ pane_id: "p" });
    expect(f.reads).toBe(1);
  });

  test("reprojects changed data once and completes partial JSONL without poisoning cache", async () => {
    const f = fixture();
    f.set([message("one")], { tail: '{"type":' });
    const first = snapshot(await f.history());
    f.set([message("one"), message("two")]);
    const [next] = await Promise.all([
      f.history(first.cursor),
      f.handlers.readSummary({ pane_id: "p" }),
    ]);
    expect(delta(next).upserts.map((entry) => entry.text)).toEqual(["two"]);
    expect(f.reads).toBe(2);
  });

  test("appends do not resend timestamp-less entries", async () => {
    const f = fixture();
    const firstRecord = {
      type: "message",
      message: { role: "user", content: "first" },
    };
    f.set([firstRecord]);
    const first = snapshot(await f.history());
    f.set([
      firstRecord,
      { type: "message", message: { role: "user", content: "second" } },
    ]);
    expect(
      delta(await f.history(first.cursor)).upserts.map((entry) => entry.text),
    ).toEqual(["second"]);
  });

  test("Codex source switching removes early projected steps instead of trusting step_id", async () => {
    const f = fixture("codex");
    const event = {
      type: "event_msg",
      timestamp: "2026-01-01T00:00:00Z",
      payload: { type: "user_message", message: "old source" },
    };
    f.set([event]);
    const first = snapshot(await f.history());
    f.set([
      event,
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "authoritative source" }],
        },
      },
    ]);
    const next = delta(await f.history(first.cursor));
    expect(next.removed).toEqual([first.entries[0].id]);
    expect(next.upserts[0].text).toBe("authoritative source");
    expect(next.order).toEqual([next.upserts[0].id]);
  });

  test("tool call IDs support argument updates and revisions preserve ordering", async () => {
    const f = fixture();
    const call = (command: string) => ({
      type: "message",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command },
          },
        ],
      },
    });
    f.set([call("a")]);
    const first = snapshot(await f.history());
    // Wire entries carry tool metadata only; the payload is fetched on demand.
    expect(first.entries[0].text).toBe("");
    expect(first.entries[0].text_bytes).toBe(
      JSON.stringify({ command: "a" }, null, 2).length,
    );
    f.set([call("longer")]);
    const next = delta(await f.history(first.cursor));
    expect(next.upserts[0].id).toBe(first.entries[0].id);
    expect(next.upserts[0].text).toBe("");
    expect(next.upserts[0].text_bytes).toBe(
      JSON.stringify({ command: "longer" }, null, 2).length,
    );
    expect(next.removed).toEqual([]);
    expect(next.order).toBeUndefined();
    const fetched = await f.handlers.readEntry({
      pane_id: "p",
      entry_id: first.entries[0].id,
    });
    expect(fetched.text).toContain("longer");
    // The fetched payload's hash matches the redacted entry it belongs to.
    expect(next.upserts[0].text_hash).toBe(fetched.text_hash);
    expect(next.upserts[0].text_hash).not.toBe(first.entries[0].text_hash);
  });

  test("readEntry rejects unknown or evicted history entries", async () => {
    const f = fixture();
    f.set([message("one")]);
    await f.history();
    await expect(
      f.handlers.readEntry({ pane_id: "p", entry_id: "missing:0" }),
    ).rejects.toThrow("no longer available");
    const fetched = await f.handlers.readEntry({
      pane_id: "p",
      entry_id: (await snapshot(await f.history())).entries[0].id,
    });
    expect(fetched.text).toBe("one");
  });

  test("recent window removes oldest entries; full export is not windowed", async () => {
    const f = fixture();
    const records = Array.from({ length: 200 }, (_, index) =>
      message(String(index)),
    );
    f.set(records);
    const first = snapshot(await f.history());
    f.set([...records, message("200")]);
    const next = delta(await f.history(first.cursor));
    expect(next.removed).toEqual([first.entries[0].id]);
    expect(next.upserts.map((entry) => entry.text)).toEqual(["200"]);
    expect(next.order).toHaveLength(200);
    const exported = await f.handlers.downloadAtif({ pane_id: "p" });
    expect((await exported.json()).steps).toHaveLength(201);
  });

  test("truncation, replacement, missing file, invalid cursors and reconnect reset safely", async () => {
    const f = fixture();
    f.set([message("long message"), message("second")]);
    let current: HistoryUpdate = await f.history();
    f.set([message("short")]);
    let next = snapshot(await f.history(current.cursor));
    expect(next.cursor.epoch).not.toBe(current.cursor.epoch);
    current = next;
    f.set([message("short")], { identity: "replacement" });
    next = snapshot(await f.history(current.cursor));
    expect(next.cursor.epoch).not.toBe(current.cursor.epoch);
    for (const cursor of [
      { epoch: next.cursor.epoch, revision: -1 },
      { epoch: next.cursor.epoch, revision: 999 },
      { epoch: "other", revision: 1 },
      "bad",
    ])
      expect((await f.history(cursor)).mode).toBe("snapshot");
    const other = createAgentSessionHandlers({
      files: f.files,
      herdrCall: f.herdrCall,
    });
    const reconnected = await other.readHistory({
      pane_id: "p",
      history_version: 2,
      cursor: next.cursor,
    });
    expect(reconnected).toHaveProperty("mode", "snapshot");
    f.missing();
    const missing = snapshot(await f.history(next.cursor));
    expect(missing.entries).toEqual([]);
    f.set([message("short")], { identity: "replacement" });
    expect((await f.history(next.cursor)).mode).toBe("snapshot");
  });

  test("expired revision history falls back to snapshot", async () => {
    const f = fixture();
    f.set([message("0")]);
    const first = await f.history();
    for (let i = 1; i < 5; i++) {
      f.set(Array.from({ length: i + 1 }, (_, j) => message(String(j))));
      await f.history();
    }
    expect((await f.history(first.cursor)).mode).toBe("snapshot");
  });

  test("changed/read races retry; transient errors do not cache partial projections", async () => {
    const f = fixture();
    f.set([message("old")]);
    f.setReadHook(() => {
      f.setReadHook();
      f.set([message("new")]);
    });
    expect(snapshot(await f.history()).entries[0].text).toBe("new");
    expect(f.reads).toBe(2);
    f.set([message("fail")]);
    f.setReadHook(() => {
      throw new Error("read failed");
    });
    await expect(f.history()).rejects.toThrow("read failed");
    f.setReadHook();
    expect(snapshot(await f.history()).entries[0].text).toBe("fail");
    f.set([message("busy")]);
    f.setReadHook(() => f.set([message("busy")]));
    await expect(f.history()).rejects.toThrow("changed while reading");
    f.setReadHook();
    expect(snapshot(await f.history()).entries[0].text).toBe("busy");
  });

  test("Grok descriptor creation time changes refresh History and ATIF timestamps", async () => {
    const f = fixture("grok");
    f.set([{ type: "user", content: "timestamp-less query" }]);
    const originalFile = { ...f.resolved.file! };
    const cache = createSessionProjectionCache(f.files);
    const first = await cache.history(f.resolved, null);
    let cursor = first.update.cursor;
    let expectedReads = 1;
    for (const createdAtMs of [2000, 5000, undefined]) {
      // Only the descriptor changes; the transcript and its stat stay identical.
      f.resolved.file = { ...originalFile, createdAtMs };
      const changed = await cache.history(f.resolved, cursor);
      const update = delta(changed.update);
      const timestamp = new Date(
        createdAtMs ?? originalFile.mtimeMs,
      ).toISOString();
      expect(update.cursor.epoch).toBe(cursor.epoch);
      expect(update.cursor.revision).toBe(cursor.revision + 1);
      expect(update.upserts[0].sent_at).toBe(timestamp);
      expect(changed.projection.trajectory.steps[0].timestamp).toBe(timestamp);
      expect(changed.projection.messages[0].sent_at).toBe(timestamp);
      expect(f.reads).toBe(++expectedReads);
      cursor = update.cursor;
      const unchanged = await cache.history(f.resolved, cursor);
      expect(delta(unchanged.update).upserts).toEqual([]);
      expect(f.reads).toBe(expectedReads);
    }
  });

  test("oversized cache admission does not serialize the entire projection", async () => {
    const f = fixture();
    f.set([message("x".repeat(100_000))]);
    const cache = createSessionProjectionCache(f.files, {
      entries: 16,
      bytes: 16 * 1024,
    });
    const stringify = JSON.stringify;
    const spy = spyOn(JSON, "stringify").mockImplementation((value) => {
      if (Array.isArray(value) && value[0]?.trajectory) {
        throw new Error("Cache admission serialized the entire projection");
      }
      return stringify(value);
    });
    try {
      const first = await cache.history(f.resolved, null);
      expect(first.projection.trajectory.steps[0].message).toHaveLength(
        100_000,
      );
      const next = await cache.history(f.resolved, first.update.cursor);
      expect(next.update.mode).toBe("snapshot");
      expect(next.update.cursor.epoch).not.toBe(first.update.cursor.epoch);
      expect(f.reads).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("entry and retained payload budgets evict with a fresh epoch", async () => {
    const f = fixture();
    f.set([message("hello")]);
    const cache = createSessionProjectionCache(f.files, {
      entries: 1,
      bytes: 1024 * 1024,
    });
    const first = await cache.history(f.resolved, null);
    await cache.get({ ...f.resolved, agent: "claude" });
    const next = await cache.history(f.resolved, first.update.cursor);
    expect(next.update.mode).toBe("snapshot");
    expect(f.reads).toBe(3);
    const tiny = createSessionProjectionCache(f.files, {
      entries: 10,
      bytes: 1,
    });
    const oversized = await tiny.history(f.resolved, null);
    expect(
      (await tiny.history(f.resolved, oversized.update.cursor)).update.mode,
    ).toBe("snapshot");
    expect(f.reads).toBe(5);
  });
});
