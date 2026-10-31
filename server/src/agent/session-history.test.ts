import { expect, test } from "bun:test";
import {
  HISTORY_WINDOW_LIMIT,
  type HistoryEntry,
  historyEntriesFromTrajectory,
  historyUpdate,
  historyTextHash,
  redactHistoryUpdate,
} from "./session-history";
import { projectAgentTrajectory } from "./session-trajectory";

const file = { path: "/tmp/history.jsonl", mtimeMs: 1000 };

test("Pi History includes tool arguments, associated outputs and errors in transcript order", () => {
  const records = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "run it" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running" },
          {
            type: "toolCall",
            id: "call1",
            name: "bash",
            arguments: { command: "false" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        isError: true,
        content: [{ type: "text", text: "exit 1" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Failed" }],
      },
    },
  ];
  const entries = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("pi", file, records),
  );
  expect(entries.map((entry) => entry.kind)).toEqual([
    "message",
    "message",
    "tool_call",
    "tool_result",
    "message",
  ]);
  expect(entries[2]).toMatchObject({
    tool_name: "bash",
    source_call_id: "call1",
    text: '{\n  "command": "false"\n}',
  });
  expect(entries[3]).toMatchObject({
    tool_name: "bash",
    source_call_id: "call1",
    text: "exit 1",
    is_error: true,
  });
});

test("Claude messages the user queued while it worked show as theirs", () => {
  const queued = (prompt: unknown, origin: unknown) => ({
    type: "attachment",
    timestamp: "2026-10-24T11:05:31.060Z",
    attachment: { type: "queued_command", prompt, origin },
  });
  const trajectory = projectAgentTrajectory("claude", file, [
    queued("Also hide the top bar", { kind: "human" }),
    queued("<task-notification>done</task-notification>", {
      kind: "task-notification",
    }),
    queued("from another session", { kind: "peer" }),
    queued([{ type: "text", text: "With an image" }], { kind: "human" }),
    { type: "attachment", attachment: { type: "todo_reminder" } },
    {
      type: "user",
      message: {
        role: "user",
        content:
          "<task-notification>\n<status>completed</status>\n</task-notification>",
      },
    },
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "[Image: original 10x20.]" },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
    ["user", "Also hide the top bar"],
    ["user", "With an image"],
  ]);
});

test("a Claude compaction summary is flagged, not a plain user message", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
    },
    {
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "This session is being continued" },
    },
    { type: "user", message: { role: "user", content: "Go on" } },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(
    entries.map((entry) => [entry.text, entry.compact_summary ?? false]),
  ).toEqual([
    ["This session is being continued", true],
    ["Go on", false],
  ]);
});

test("an Artifact result keeps the page it published when redacted", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a1",
            name: "Artifact",
            input: { file_path: "/tmp/notes.html" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a1",
            content:
              "Published /tmp/notes.html at https://claude.ai/artifact/N1",
          },
        ],
      },
    },
  ]);
  const update = redactHistoryUpdate({
    history_version: 2,
    cursor: { epoch: "e", revision: 1 },
    window_limit: HISTORY_WINDOW_LIMIT,
    mode: "snapshot",
    entries: historyEntriesFromTrajectory(file, trajectory),
  });
  const entries = update.mode === "snapshot" ? update.entries : [];
  expect(entries.find((entry) => entry.kind === "tool_result")).toMatchObject({
    text: "",
    artifact: { url: "https://claude.ai/artifact/N1", title: "notes" },
  });
});

test("Claude messages still in its queue show as queued until they land", () => {
  const op = (operation: string, content?: string) => ({
    type: "queue-operation",
    operation,
    timestamp: "2026-10-24T11:05:31.060Z",
    ...(content === undefined ? {} : { content }),
  });
  const project = (records: Record<string, unknown>[]) =>
    historyEntriesFromTrajectory(
      file,
      projectAgentTrajectory("claude", file, records),
    ).map((entry) => [entry.text, entry.queued ?? false]);
  const waiting = [
    op("enqueue", "first"),
    op("enqueue", "<task-notification>x</task-notification>"),
    op("enqueue", "second"),
    op("enqueue", "third"),
  ];
  expect(project(waiting)).toEqual([
    ["first", true],
    ["second", true],
    ["third", true],
  ]);
  // Absorbed mid-turn (a queued command), and the oldest taking a new turn.
  const later = project([
    ...waiting,
    op("remove", "second"),
    {
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: "second",
        origin: { kind: "human" },
      },
    },
    op("dequeue"),
    { type: "user", message: { role: "user", content: "first" } },
  ]);
  expect(later).toEqual([
    ["second", false],
    ["first", false],
    ["third", true],
  ]);
  // Up gives the whole queue back to the prompt; one is sent again.
  expect(
    project([
      ...waiting,
      op("popAll", "first"),
      op("popAll", "second"),
      op("popAll", "third"),
      op("enqueue", "third"),
    ]),
  ).toEqual([["third", true]]);
});

test("a hidden Claude queue item keeps its place for the next dequeue", () => {
  const op = (operation: string, content?: string) => ({
    type: "queue-operation",
    operation,
    timestamp: "2026-10-24T11:05:31.060Z",
    ...(content === undefined ? {} : { content }),
  });
  // The notification queued first is the one the dequeue takes: the user's
  // message still waits.
  const entries = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("claude", file, [
      op("enqueue", "<task-notification>done</task-notification>"),
      op("enqueue", "mine"),
      op("dequeue"),
    ]),
  );
  expect(entries.map((entry) => [entry.text, entry.queued ?? false])).toEqual([
    ["mine", true],
  ]);
});

test("a Claude message that took its turn is not left queued", () => {
  const op = (operation: string, content?: string) => ({
    type: "queue-operation",
    operation,
    timestamp: "2026-10-24T11:05:31.060Z",
    ...(content === undefined ? {} : { content }),
  });
  const user = (content: string) => ({
    type: "user",
    message: { role: "user", content },
  });
  const project = (records: Record<string, unknown>[]) =>
    historyEntriesFromTrajectory(
      file,
      projectAgentTrajectory("claude", file, records),
    ).map((entry) => [entry.text, entry.queued ?? false]);
  // Claude Code drops attributes from another session's message when it
  // takes it out (hop-chain): that one leaves the queue all the same, and
  // a message sent later is not held behind it.
  const crossSession = (attributes: string) =>
    `<cross-session-message from="uds:/tmp/a.sock"${attributes}>\nhello\n</cross-session-message>`;
  expect(
    project([
      op("enqueue", crossSession(' hop-chain="1,2" from-name="other"')),
      op("remove", crossSession(' from-name="other"')),
      op("enqueue", "Has upstream started reviewing?"),
      op("dequeue"),
      user("Has upstream started reviewing?"),
    ]),
  ).toEqual([["Has upstream started reviewing?", false]]);
  // Whatever is left in the line, the dequeue takes the message its turn
  // shows, not the oldest: what the session shows as the user's is never
  // also drawn as queued.
  expect(
    project([
      op("enqueue", "<task-notification>done</task-notification>"),
      op("enqueue", "first"),
      op("dequeue"),
      user("first"),
      op("enqueue", "second"),
      op("dequeue"),
      user("second"),
    ]),
  ).toEqual([
    ["first", false],
    ["second", false],
  ]);
  // A turn that shows a queued message ends its wait even with no dequeue.
  expect(project([op("enqueue", "third"), user("third")])).toEqual([
    ["third", false],
  ]);
  // Several messages taken as one turn all leave the queue; one sent while
  // that turn runs still waits.
  expect(
    project([
      op("enqueue", "one"),
      op("enqueue", "two"),
      op("dequeue"),
      op("dequeue"),
      user("one\n\ntwo"),
      op("enqueue", "three"),
    ]),
  ).toEqual([
    ["one\n\ntwo", false],
    ["three", true],
  ]);
});

test("a queued Claude message that lands reaches a client as one changed entry", () => {
  const records: Record<string, unknown>[] = [
    { type: "user", message: { role: "user", content: "start" } },
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-10-24T11:05:31.060Z",
      content: "also this",
    },
  ];
  const before = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("claude", file, records),
  );
  const after = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("claude", file, [
      ...records,
      { type: "queue-operation", operation: "dequeue" },
      { type: "user", message: { role: "user", content: "also this" } },
    ]),
  );
  const queued = before.find((entry) => entry.queued);
  expect(queued?.text).toBe("also this");
  const update = historyUpdate(
    { epoch: "e", revision: 2 },
    after,
    { epoch: "e", revision: 1 },
    new Map([[1, before]]),
  );
  if (update.mode !== "delta") throw new Error("expected a delta");
  // Same id, flag gone: the client replaces the queued bubble in place.
  expect(update.upserts).toEqual([
    expect.objectContaining({ id: queued!.id, text: "also this" }),
  ]);
  expect(update.upserts[0]!.queued).toBeUndefined();
  expect(update.removed).toEqual([]);
});

test("Claude mixed text/tool blocks retain order and error output is not counted as a user turn", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-test-model",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: "text", text: "Before" },
          {
            type: "tool_use",
            id: "call",
            name: "Read",
            input: { path: "missing" },
          },
          { type: "text", text: "After" },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: "not found",
            is_error: true,
          },
          { type: "text", text: "Try again" },
          {
            type: "text",
            text: "[Image: original 1080x2424, displayed at 891x2000.]",
          },
        ],
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(entries.map((entry) => entry.kind)).toEqual([
    "message",
    "tool_call",
    "message",
    "tool_result",
    "message",
  ]);
  expect(entries[3]).toMatchObject({
    tool_name: "Read",
    source_call_id: "call",
    is_error: true,
    text: "not found",
  });
  expect(entries.filter((entry) => entry.role === "user")).toHaveLength(1);
  expect(trajectory.steps[2]).toMatchObject({
    extra: { record_type: "assistant", model: "claude-test-model" },
    metrics: { prompt_tokens: 10, completion_tokens: 5 },
  });
  expect(trajectory.steps[4].extra?.record_type).toBe("user");
});

test("Pi interleaved tool and text parts remain in source order", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "read",
            arguments: { path: "a" },
          },
          { type: "text", text: "After call" },
          {
            type: "toolCall",
            id: "call2",
            name: "read",
            arguments: { path: "b" },
          },
        ],
      },
    },
  ]);
  expect(
    historyEntriesFromTrajectory(file, trajectory).map((entry) => entry.kind),
  ).toEqual(["tool_call", "message", "tool_call"]);
});

test.each(["stop", "error"])(
  "Pi interleaved ATIF preserves source metadata with stop reason %s",
  (stopReason) => {
    const trajectory = projectAgentTrajectory("pi", file, [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "test-model",
          stopReason,
          errorMessage: "interrupted",
          usage: { input: 10, output: 5 },
          content: [
            { type: "toolCall", id: "call", name: "read", arguments: {} },
            { type: "text", text: "After call" },
          ],
        },
      },
    ]);
    const lastStep = trajectory.steps.at(-1)!;
    expect(lastStep).toMatchObject({
      extra: {
        record_type: "message",
        provider: "test-provider",
        model: "test-model",
        stop_reason: stopReason,
      },
      metrics: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(lastStep.extra?.error_message).toBe(
      stopReason === "error" ? "interrupted" : undefined,
    );
  },
);

test("Codex preserves explicit tool errors and call association", () => {
  const trajectory = projectAgentTrajectory("codex", file, [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call",
        arguments: '{"command":"false"}',
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call",
        output: "exit 1",
        status: "failed",
      },
    },
  ]);
  expect(historyEntriesFromTrajectory(file, trajectory)[1]).toMatchObject({
    kind: "tool_result",
    source_call_id: "call",
    tool_name: "shell",
    text: "exit 1",
    is_error: true,
  });
});

test("external call IDs with commas are hashed before order comparison", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: ["a,b", "c", "a", "b,c"].map((id) => ({
          type: "toolCall",
          id,
          name: "read",
          arguments: {},
        })),
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  for (const entry of entries) expect(entry.id).toMatch(/^[0-9a-f]{24}:\d+$/);
  expect(entries.map((entry) => entry.source_call_id)).toEqual([
    "a,b",
    "c",
    "a",
    "b,c",
  ]);
  const reversed = entries.toReversed();
  const update = historyUpdate(
    { epoch: "test", revision: 2 },
    reversed,
    { epoch: "test", revision: 1 },
    new Map([[1, entries]]),
  );
  expect(update).toMatchObject({
    mode: "delta",
    upserts: [],
    removed: [],
    order: reversed.map((entry) => entry.id),
  });
});

test("window counts conversation entries only; tool entries ride along", () => {
  const records = [];
  for (let index = 0; index < HISTORY_WINDOW_LIMIT + 5; index++) {
    records.push({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: `turn ${index}` }],
      },
    });
    records.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "bash",
            arguments: { command: `echo ${index}` },
          },
        ],
      },
    });
  }
  const entries = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("pi", file, records),
  );
  const conversation = entries.filter((entry) => entry.role !== "tool");
  expect(conversation).toHaveLength(HISTORY_WINDOW_LIMIT);
  // The five oldest user turns are evicted; their tool calls drop with them.
  expect(conversation[0].text).toBe("turn 5");
  expect(entries.filter((entry) => entry.role === "tool")).toHaveLength(
    HISTORY_WINDOW_LIMIT,
  );
  expect(entries[0].text).toBe("turn 5");
  expect(entries[1].kind).toBe("tool_call");
});

test("redaction strips tool payloads but keeps metadata for on-demand fetches", () => {
  const tool: HistoryEntry = {
    id: "t:0",
    role: "tool",
    kind: "tool_result",
    text: "bulk output",
    sent_at: "2026-01-01T00:00:00Z",
    tool_name: "bash",
    is_error: false,
  };
  const user: HistoryEntry = {
    id: "u:0",
    role: "user",
    kind: "message",
    text: "keep me",
    sent_at: "2026-01-01T00:00:00Z",
  };
  const snapshot = redactHistoryUpdate({
    history_version: 2,
    mode: "snapshot",
    cursor: { epoch: "e", revision: 1 },
    window_limit: HISTORY_WINDOW_LIMIT,
    entries: [user, tool],
  });
  if (snapshot.mode !== "snapshot") throw new Error("Expected snapshot");
  expect(snapshot.entries[0]).toEqual(user);
  expect(snapshot.entries[1]).toMatchObject({
    id: "t:0",
    text: "",
    text_bytes: "bulk output".length,
    tool_name: "bash",
  });
  // Non-ASCII payloads report real UTF-8 bytes, not string length.
  const nonAscii = redactHistoryUpdate({
    history_version: 2,
    mode: "snapshot",
    cursor: { epoch: "e", revision: 1 },
    window_limit: HISTORY_WINDOW_LIMIT,
    entries: [{ ...tool, id: "t:1", text: "你好世界" }],
  });
  if (nonAscii.mode !== "snapshot") throw new Error("Expected snapshot");
  expect(nonAscii.entries[0].text_bytes).toBe(
    Buffer.byteLength("你好世界", "utf8"),
  );
  const delta = redactHistoryUpdate({
    history_version: 2,
    mode: "delta",
    cursor: { epoch: "e", revision: 2 },
    base_revision: 1,
    window_limit: HISTORY_WINDOW_LIMIT,
    upserts: [tool],
    removed: [user.id],
  });
  if (delta.mode !== "delta") throw new Error("Expected delta");
  expect(delta.upserts[0].text).toBe("");
  expect(delta.upserts[0].text_bytes).toBe("bulk output".length);
  expect(delta.removed).toEqual([user.id]);
});

test("redacted tool payloads carry a content hash that tracks rewrites", () => {
  const tool: HistoryEntry = {
    id: "t:0",
    role: "tool",
    kind: "tool_call",
    tool_name: "bash",
    text: '{"command":"a"}',
    sent_at: "2026-01-01T00:00:00Z",
  };
  const redact = (entry: HistoryEntry) => {
    const update = redactHistoryUpdate({
      history_version: 2,
      mode: "snapshot",
      cursor: { epoch: "e", revision: 1 },
      window_limit: HISTORY_WINDOW_LIMIT,
      entries: [entry],
    });
    if (update.mode !== "snapshot") throw new Error("Expected snapshot");
    return update.entries[0];
  };
  const before = redact(tool);
  // Rewritten in place at the same byte length: only the hash changes.
  const after = redact({ ...tool, text: '{"command":"b"}' });
  expect(before.text_hash).toBe(historyTextHash(tool.text));
  expect(after.text_bytes).toBe(before.text_bytes);
  expect(after.text_hash).not.toBe(before.text_hash);
});

test("content identities survive early step renumbering and disambiguate repeated messages", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    { type: "message", message: { role: "user", content: "same" } },
    { type: "message", message: { role: "user", content: "same" } },
  ]);
  const first = historyEntriesFromTrajectory(file, trajectory);
  const next = historyEntriesFromTrajectory(file, {
    ...trajectory,
    steps: trajectory.steps.map((step) => ({
      ...step,
      step_id: step.step_id + 3,
    })),
  });
  expect(first.map((entry) => entry.id)).toEqual(next.map((entry) => entry.id));
  expect(new Set(first.map((entry) => entry.id)).size).toBe(2);
});
