import { expect, test } from "bun:test";
import type { HistoryEntry } from "./agentHistory";
import {
  groupHistoryChatItems,
  pairToolSteps,
  previewToolArgumentFields,
  searchHistoryChatEntries,
  summarizeToolSteps,
  toolArgumentFields,
  toolArgumentHeadline,
  toolPayloadKey,
} from "./agentHistoryView";

function entry(
  id: string,
  role: HistoryEntry["role"],
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  return {
    id,
    role,
    kind: role === "tool" ? "tool_call" : "message",
    text: `${role} ${id}`,
    sent_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("consecutive tool entries collapse into one chat block", () => {
  const items = groupHistoryChatItems([
    entry("1", "user"),
    entry("2", "tool"),
    entry("3", "tool", { kind: "tool_result" }),
    entry("4", "assistant"),
    entry("5", "tool"),
  ]);
  expect(
    items.map((item) =>
      item.type === "message"
        ? item.entry.id
        : item.entries.map((tool) => tool.id),
    ),
  ).toEqual(["1", ["2", "3"], "4", ["5"]]);
  // Group keys follow their first entry so appended results keep identity.
  expect(items[1]).toMatchObject({ type: "tools", id: "tools:2" });
  // Minimap sequences count bubbles only, skipping tool rows.
  expect(items[0]).toMatchObject({ type: "message", sequence: 1 });
  expect(items[2]).toMatchObject({ type: "message", sequence: 2 });
});

test("tool block summaries count paired steps by tool, most used first", () => {
  expect(
    summarizeToolSteps(
      pairToolSteps([
        entry("1", "tool", { tool_name: "read" }),
        entry("2", "tool", { kind: "tool_result", tool_name: "read" }),
        entry("3", "tool", { tool_name: "bash" }),
        entry("4", "tool", {
          kind: "tool_result",
          tool_name: "bash",
          is_error: true,
        }),
        entry("5", "tool", { tool_name: "bash" }),
        entry("6", "tool", { kind: "tool_result", tool_name: "bash" }),
      ]),
    ),
  ).toEqual({
    calls: 3,
    errors: 1,
    tools: [
      { name: "bash", count: 2 },
      { name: "read", count: 1 },
    ],
  });
  // Results whose calls left the history window stand in for them.
  expect(
    summarizeToolSteps(
      pairToolSteps([
        entry("1", "tool", { kind: "tool_result", tool_name: "edit" }),
      ]),
    ),
  ).toEqual({ calls: 1, errors: 0, tools: [{ name: "edit", count: 1 }] });
});

test("tool steps pair each call with its result by call id", () => {
  const steps = pairToolSteps([
    entry("1", "tool", { tool_name: "read", source_call_id: "a" }),
    entry("2", "tool", { tool_name: "bash", source_call_id: "b" }),
    entry("3", "tool", { kind: "tool_result", source_call_id: "b" }),
    entry("4", "tool", { kind: "tool_result", source_call_id: "a" }),
    // Its call left the history window: the result stands alone.
    entry("5", "tool", {
      kind: "tool_result",
      tool_name: "edit",
      source_call_id: "z",
    }),
  ]);
  expect(
    steps.map((step) => [step.name, step.call?.id, step.result?.id]),
  ).toEqual([
    ["read", "1", "4"],
    ["bash", "2", "3"],
    ["edit", undefined, "5"],
  ]);
});

test("argument headlines pick the most telling field", () => {
  expect(
    toolArgumentHeadline(
      JSON.stringify({ description: "List files", command: "ls -la\npwd" }),
    ),
  ).toBe("ls -la");
  expect(toolArgumentHeadline(JSON.stringify({ file_path: "/a/b.ts" }))).toBe(
    "/a/b.ts",
  );
  expect(toolArgumentHeadline(JSON.stringify({ limit: 5 }))).toBe(
    '{"limit":5}',
  );
  expect(toolArgumentHeadline("\n  plain text args\nmore")).toBe(
    "plain text args",
  );
});

test("argument fields keep strings verbatim and format other values", () => {
  expect(
    toolArgumentFields(
      JSON.stringify({ command: "ls", description: "List", opts: { a: 1 } }),
    ),
  ).toEqual([
    { key: "command", value: "ls", code: true },
    { key: "description", value: "List", code: false },
    { key: "opts", value: '{\n  "a": 1\n}', code: true },
  ]);
  expect(toolArgumentFields("not json")).toEqual([
    { key: "", value: "not json", code: true },
  ]);
  expect(toolArgumentFields("")).toEqual([]);
});

test("tool steps without call ids pair with the next call of the same tool", () => {
  const steps = pairToolSteps([
    entry("1", "tool", { tool_name: "bash" }),
    entry("2", "tool", { tool_name: "read" }),
    entry("3", "tool", { kind: "tool_result", tool_name: "read" }),
    entry("4", "tool", { kind: "tool_result", tool_name: "bash" }),
    // An id on both sides that does not match never pairs by name.
    entry("5", "tool", { tool_name: "edit", source_call_id: "x" }),
    entry("6", "tool", {
      kind: "tool_result",
      tool_name: "edit",
      source_call_id: "y",
    }),
  ]);
  expect(
    steps.map((step) => [step.name, step.call?.id, step.result?.id]),
  ).toEqual([
    ["bash", "1", "4"],
    ["read", "2", "3"],
    ["edit", "5", undefined],
    ["edit", undefined, "6"],
  ]);
});

test("chat search keeps a tool call and its result together", () => {
  const entries = [
    entry("1", "user", { text: "fix the build" }),
    entry("2", "tool", {
      tool_name: "bash",
      source_call_id: "a",
      text: '{"command":"bun run build"}',
    }),
    // Redacted result: it cannot match on its own text.
    entry("3", "tool", {
      kind: "tool_result",
      tool_name: "bash",
      source_call_id: "a",
      text: "",
      text_bytes: 40,
    }),
    entry("4", "tool", {
      tool_name: "read",
      source_call_id: "b",
      text: '{"file_path":"a.ts"}',
    }),
    entry("5", "tool", {
      kind: "tool_result",
      tool_name: "read",
      source_call_id: "b",
      text: "export const build = 1;",
    }),
    entry("6", "assistant", { text: "done" }),
  ];
  const ids = (query: string) =>
    searchHistoryChatEntries(entries, query).map((item) => item.id);
  expect(ids("build")).toEqual(["1", "2", "3", "4", "5"]);
  expect(ids("bun run")).toEqual(["2", "3"]);
  expect(ids("done")).toEqual(["6"]);
  expect(ids("  ")).toEqual(["1", "2", "3", "4", "5", "6"]);
});

test("argument previews share one budget across all fields", () => {
  const field = (key: string, value: string) => ({ key, value, code: false });
  // Many short fields: each fits on its own, but together they exceed the
  // budget, so the preview stops and reports truncation.
  const many = Array.from({ length: 1000 }, (_, i) => field(`k${i}`, "abcdef"));
  const clipped = previewToolArgumentFields(many, 100);
  expect(clipped.truncated).toBe(true);
  expect(
    clipped.fields.reduce(
      (total, item) => total + item.key.length + item.value.length,
      0,
    ),
  ).toBeLessThanOrEqual(100);
  // One long field is cut to what is left of the budget.
  expect(previewToolArgumentFields([field("cmd", "x".repeat(50))], 13)).toEqual(
    { fields: [field("cmd", "x".repeat(10))], truncated: true },
  );
  // Fields that fit are returned whole.
  const fits = [field("a", "1"), field("b", "2")];
  expect(previewToolArgumentFields(fits, 100)).toEqual({
    fields: fits,
    truncated: false,
  });
});

test("payload keys change when an entry is rewritten under the same id", () => {
  const stub = entry("7", "tool", { text: "", text_bytes: 120 });
  expect(toolPayloadKey(stub)).toBe(toolPayloadKey({ ...stub }));
  expect(toolPayloadKey(stub)).not.toBe(
    toolPayloadKey({ ...stub, text_bytes: 180 }),
  );
});
