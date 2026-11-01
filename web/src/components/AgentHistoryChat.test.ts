import { expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentHistoryChat } from "./AgentHistoryChat";
import { HISTORY_PREVIEW_CHARS } from "./AgentHistoryCard";
import type { HistoryEntry } from "./agentHistory";
import { groupHistoryChatItems } from "./agentHistoryView";

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

function renderChat(entries: HistoryEntry[], highlightedSequence?: number) {
  return renderToStaticMarkup(
    createElement(AgentHistoryChat, {
      items: groupHistoryChatItems(entries),
      listRef: createRef<HTMLDivElement>(),
      contentRef: createRef<HTMLDivElement>(),
      highlightedSequence,
      onOpen() {},
    }),
  );
}

// Assistant bubbles sanitize rendered markdown with DOMParser.
async function withMarkdownDom<T>(render: () => T): Promise<T> {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const globals = {
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
  };
  const originals = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  try {
    return render();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await browser.happyDOM.close();
  }
}

test("chat renders user text plainly, assistant markdown, and collapsed tool blocks", async () => {
  const markup = await withMarkdownDom(() =>
    renderChat(
      [
        entry("1", "user", { text: "**not bold**" }),
        entry("2", "tool", { tool_name: "bash", text: "", text_bytes: 12 }),
        entry("3", "tool", {
          kind: "tool_result",
          tool_name: "bash",
          is_error: true,
        }),
        entry("4", "assistant", { text: "**bold**" }),
        entry("5", "assistant", { kind: "error", text: "boom" }),
      ],
      2,
    ),
  );
  expect(markup).toContain("<p>**not bold**</p>");
  expect(markup).toContain("<strong>bold</strong>");
  // Tool blocks start collapsed: a summary row only, no entry list.
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("<strong>1 tool call</strong>");
  expect(markup).toContain("1 error");
  expect(markup).not.toContain("agent-history-chat-tools-list");
  expect(markup).toContain("agent-history-chat-message is-error");
  // Bubbles carry minimap sequences; the jump target flashes.
  expect(markup).toContain('data-sequence="3"');
  expect(markup).toMatch(
    /is-assistant is-minimap-target"[^>]*data-sequence="2"/,
  );
});

test("long chat messages are clipped behind a full-message button", () => {
  const text = "x".repeat(HISTORY_PREVIEW_CHARS + 10);
  const markup = renderChat([entry("1", "user", { text })]);
  expect(markup).toContain("View full message");
  expect(markup).not.toContain(text);
});

test("queued messages are marked and a compaction summary is one line", () => {
  const summary = "This session is being continued from an earlier one";
  const markup = renderChat([
    entry("1", "user", { text: summary, compact_summary: true }),
    entry("2", "user", { text: "waiting", queued: true }),
    entry("3", "user", { text: "landed" }),
  ]);
  expect(markup).toContain("Conversation compacted");
  expect(markup).toContain("Show the summary");
  expect(markup).not.toContain(summary);
  expect(markup.match(/is-queued/g)).toHaveLength(1);
  expect(markup.match(/>Queued</g)).toHaveLength(1);
});
