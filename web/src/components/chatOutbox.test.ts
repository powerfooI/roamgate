import { describe, expect, test } from "bun:test";
import type { HistoryEntry } from "./agentHistory";
import {
  newOutboxMessage,
  nextOutboxDeadline,
  OUTBOX_LIMIT,
  type OutboxMessage,
  readOutbox,
  settleOutbox,
  subscribeOutbox,
  updateOutbox,
} from "./chatOutbox";

function user(id: string, text: string, extra: Partial<HistoryEntry> = {}) {
  return {
    id,
    kind: "message",
    role: "user",
    text,
    sent_at: "2026-10-28T12:00:00.000Z",
    ...extra,
  } as HistoryEntry;
}

function sent(message: OutboxMessage): OutboxMessage {
  return { ...message, state: "sent" };
}

describe("settleOutbox", () => {
  test("keeps a message until the transcript shows it", () => {
    const history = [user("a", "Look at the readme")];
    const message = sent(newOutboxMessage("p1", "Run the tests", history, 0));
    const outbox = [message];
    expect(settleOutbox(outbox, history, 1000)).toBe(outbox);
    expect(
      settleOutbox(outbox, [...history, user("b", "Run the tests")], 2000),
    ).toEqual([]);
  });

  test("never takes a message the history had before it was sent", () => {
    const history = [user("a", "Again")];
    const outbox = [sent(newOutboxMessage("p1", "Again", history, 0))];
    expect(settleOutbox(outbox, history, 1000)).toHaveLength(1);
    expect(
      settleOutbox(outbox, [...history, user("b", "Again")], 1000),
    ).toEqual([]);
  });

  test("takes the message as queued too", () => {
    const outbox = [sent(newOutboxMessage("p1", "And then?", [], 0))];
    expect(
      settleOutbox(outbox, [user("q", "And then?", { queued: true })], 10),
    ).toEqual([]);
  });

  test("tolerates the transcript rewriting whitespace", () => {
    const outbox = [
      sent(newOutboxMessage("p1", "  two\n\nlines \t here ", [], 0)),
    ];
    expect(settleOutbox(outbox, [user("b", "two lines here")], 10)).toEqual([]);
  });

  test("matches a message the agent added to", () => {
    const outbox = [sent(newOutboxMessage("p1", "What is in it?", [], 0))];
    expect(
      settleOutbox(outbox, [user("b", "[Image #1] What is in it?")], 10),
    ).toEqual([]);
  });

  test("ignores the agent's own and other words", () => {
    const outbox = [sent(newOutboxMessage("p1", "ok", [], 0))];
    const history = [
      user("b", "ok", { role: "assistant" }),
      user("c", "ok then, go on"),
      user("d", "ok", { compact_summary: true }),
    ];
    expect(settleOutbox(outbox, history, 10)).toHaveLength(1);
  });

  test("pairs messages with the same words in order", () => {
    const first = sent(newOutboxMessage("p1", "Next", [], 0));
    const second = sent(newOutboxMessage("p1", "Next", [], 5));
    const third = sent(newOutboxMessage("p1", "Done", [], 9));
    const left = settleOutbox([first, second, third], [user("b", "Next")], 20);
    expect(left.map((message) => message.id)).toEqual([second.id, third.id]);
  });

  test("fails a sent message the transcript never shows", () => {
    const outbox = [sent(newOutboxMessage("p1", "Hello", [], 0))];
    const [late] = settleOutbox(outbox, [], 1000, 1000);
    expect(late?.state).toBe("failed");
    expect(late?.reason).toBeTruthy();
    // Still taken if it shows up after all.
    expect(settleOutbox([late!], [user("b", "Hello")], 5000, 1000)).toEqual([]);
  });

  test("does not time out a message still being sent", () => {
    const outbox = [newOutboxMessage("p1", "Hello", [], 0)];
    expect(settleOutbox(outbox, [], 10_000, 1000)).toBe(outbox);
  });
});

test("nextOutboxDeadline is the earliest sent message's", () => {
  const sending = newOutboxMessage("p1", "a", [], 0);
  expect(nextOutboxDeadline([sending], 100)).toBeNull();
  expect(
    nextOutboxDeadline(
      [sent({ ...sending, sentAtMs: 50 }), sent({ ...sending, sentAtMs: 20 })],
      100,
    ),
  ).toBe(120);
});

describe("pane outboxes", () => {
  test("a pane's messages outlive the chat that showed them", () => {
    const key = "pane-store-1";
    let changes = 0;
    const unsubscribe = subscribeOutbox(() => changes++);
    const failed: OutboxMessage = {
      ...newOutboxMessage("p1", "Not lost", [], 0),
      state: "failed",
      reason: "pane closed",
    };
    updateOutbox(key, (current) => [...current, failed]);
    unsubscribe();
    // A chat mounted later, for the terminal's round trip, reads it back.
    expect(readOutbox(key)).toEqual([failed]);
    expect(readOutbox("pane-store-2")).toEqual([]);
    expect(changes).toBe(1);
    // No change, no notice; emptied, the pane's entry goes.
    updateOutbox(key, (current) => current);
    updateOutbox(key, () => []);
    expect(readOutbox(key)).toEqual([]);
  });

  test("keeps the newest messages of a pane within its limit", () => {
    const key = "pane-store-limit";
    for (let index = 0; index < OUTBOX_LIMIT + 5; index++)
      updateOutbox(key, (current) => [
        ...current,
        newOutboxMessage("p1", `message ${index}`, [], index),
      ]);
    const kept = readOutbox(key);
    expect(kept).toHaveLength(OUTBOX_LIMIT);
    expect(kept[0]?.text).toBe("message 5");
    updateOutbox(key, () => []);
  });
});
