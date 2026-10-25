import { describe, expect, test } from "bun:test";
import {
  activateTerminalComposerDraftScope,
  beginTerminalComposerSubmission,
  beginTerminalComposerUpload,
  clearTerminalComposerDraft,
  clearTerminalComposerDrafts,
  finishTerminalComposerSubmission,
  finishTerminalComposerUpload,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  submitTerminalComposerDraft,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  subscribeTerminalComposerUpload,
  terminalComposerCloseWarning,
  terminalComposerDraftCount,
  terminalComposerDraftKey,
  terminalComposerDraftPaneIds,
  terminalComposerInsertAtCaret,
  sendTerminalComposerText,
  terminalComposerRequest,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "./terminalComposer";

describe("terminal composer drafts", () => {
  test("scopes drafts by connection, generation, and pane", () => {
    const first = terminalComposerDraftKey("conn-a", 1, "pane-1");
    const switchedPane = terminalComposerDraftKey("conn-a", 1, "pane-2");
    const reconnected = terminalComposerDraftKey("conn-a", 2, "pane-1");
    const otherConnection = terminalComposerDraftKey("conn-b", 1, "pane-1");
    const keys = [first, switchedPane, reconnected, otherConnection];
    expect(new Set(keys).size).toBe(keys.length);

    writeTerminalComposerDraft(first, "draft one");
    writeTerminalComposerDraft(switchedPane, "draft two");
    expect(readTerminalComposerDraft(first)).toBe("draft one");
    expect(readTerminalComposerDraft(switchedPane)).toBe("draft two");
    expect(readTerminalComposerDraft(reconnected)).toBe("");
    expect(readTerminalComposerDraft(otherConnection)).toBe("");

    clearTerminalComposerDraft(first);
    clearTerminalComposerDraft(switchedPane);
  });

  test("digit-ending connection ids cannot collide across generations", () => {
    const first = terminalComposerDraftKey("srv1", 2, "pane-1");
    const second = terminalComposerDraftKey("srv", 12, "pane-1");
    expect(first).not.toBe(second);

    writeTerminalComposerDraft(first, "draft one");
    writeTerminalComposerDraft(second, "draft two");
    expect(readTerminalComposerDraft(first)).toBe("draft one");
    expect(readTerminalComposerDraft(second)).toBe("draft two");

    clearTerminalComposerDraft(first);
    clearTerminalComposerDraft(second);
  });

  test("drops empty drafts instead of retaining them", () => {
    const key = terminalComposerDraftKey("conn-c", 1, "pane-9");
    const before = terminalComposerDraftCount();
    writeTerminalComposerDraft(key, "hello");
    expect(terminalComposerDraftCount()).toBe(before + 1);
    writeTerminalComposerDraft(key, "");
    expect(terminalComposerDraftCount()).toBe(before);
    expect(readTerminalComposerDraft(key)).toBe("");
  });

  test("finds and clears drafts only for the given panes", () => {
    writeTerminalComposerDraft(terminalComposerDraftKey("c", 1, "p1"), "a");
    writeTerminalComposerDraft(terminalComposerDraftKey("c", 1, "p2"), "");
    writeTerminalComposerDraft(terminalComposerDraftKey("c", 1, "p3"), "b");
    writeTerminalComposerDraft(terminalComposerDraftKey("c", 2, "p1"), "gen");

    expect(terminalComposerDraftPaneIds("c", 1, ["p1", "p2", "p3"])).toEqual([
      "p1",
      "p3",
    ]);

    clearTerminalComposerDrafts("c", 1, ["p1", "p3"]);
    expect(terminalComposerDraftPaneIds("c", 1, ["p1", "p2", "p3"])).toEqual(
      [],
    );
    // Other generations stay untouched.
    expect(
      readTerminalComposerDraft(terminalComposerDraftKey("c", 2, "p1")),
    ).toBe("gen");
    clearTerminalComposerDrafts("c", 2, ["p1"]);
  });

  test("notifies active composers when async work updates a draft", () => {
    const key = terminalComposerDraftKey("notify", 1, "p1");
    const observed: string[] = [];
    const unsubscribe = subscribeTerminalComposerDraft(key, (text) =>
      observed.push(text),
    );

    writeTerminalComposerDraft(key, "sent command");
    clearTerminalComposerDraft(key);
    unsubscribe();
    writeTerminalComposerDraft(key, "after unsubscribe");

    expect(observed).toEqual(["sent command", ""]);
    clearTerminalComposerDraft(key);
  });

  test("serializes submissions per draft key across mounts", () => {
    const first = terminalComposerDraftKey("submit", 1, "p1");
    const otherPane = terminalComposerDraftKey("submit", 1, "p2");
    const observed: boolean[] = [];
    const unsubscribe = subscribeTerminalComposerSubmission(first, (pending) =>
      observed.push(pending),
    );

    expect(beginTerminalComposerSubmission(first)).toBe(true);
    expect(terminalComposerSubmissionPending(first)).toBe(true);
    expect(beginTerminalComposerSubmission(first)).toBe(false);
    expect(beginTerminalComposerSubmission(otherPane)).toBe(true);

    finishTerminalComposerSubmission(first);
    expect(terminalComposerSubmissionPending(first)).toBe(false);
    expect(observed).toEqual([true, false]);

    unsubscribe();
    finishTerminalComposerSubmission(otherPane);
  });

  test("submits a draft prefix once and restores it ahead of newer text on failure", async () => {
    const key = terminalComposerDraftKey("submit-helper", 1, "p1");
    writeTerminalComposerDraft(key, "hello");
    let release!: () => void;
    const sent: string[] = [];
    const pending = submitTerminalComposerDraft(
      key,
      "hello",
      (text) =>
        new Promise<void>((resolve) => {
          sent.push(text);
          release = resolve;
        }),
    );
    // The sent prefix leaves the draft at once; a second submit is refused.
    expect(readTerminalComposerDraft(key)).toBe("");
    expect(
      await submitTerminalComposerDraft(key, "hello", async () => {}),
    ).toBe(false);
    release();
    expect(await pending).toBe(true);
    expect(sent).toEqual(["hello"]);
    expect(terminalComposerSubmissionPending(key)).toBe(false);

    writeTerminalComposerDraft(key, "retry");
    const failed = submitTerminalComposerDraft(key, "retry", async () => {
      writeTerminalComposerDraft(key, " later");
      throw new Error("pane closed");
    });
    await expect(failed).rejects.toThrow("pane closed");
    expect(readTerminalComposerDraft(key)).toBe("retry later");
    expect(terminalComposerSubmissionPending(key)).toBe(false);
    clearTerminalComposerDraft(key);
  });

  test("tracks uploads across composer remounts", () => {
    const key = terminalComposerDraftKey("upload-pending", 1, "p1");
    const observed: number[] = [];
    const unsubscribe = subscribeTerminalComposerUpload(key, (count) =>
      observed.push(count),
    );

    expect(beginTerminalComposerUpload(key)).toBe(true);
    expect(terminalComposerUploadCount(key)).toBe(1);
    expect(beginTerminalComposerUpload(key)).toBe(true);
    finishTerminalComposerUpload(key);
    expect(terminalComposerUploadCount(key)).toBe(1);
    finishTerminalComposerUpload(key);

    expect(terminalComposerUploadCount(key)).toBe(0);
    expect(observed).toEqual([1, 2, 1, 0]);
    unsubscribe();
  });

  test("inserts async results into the latest shared draft", () => {
    const key = terminalComposerDraftKey("upload", 1, "p1");
    writeTerminalComposerDraft(key, "newer edits");

    expect(insertIntoTerminalComposerDraft(key, "/tmp/image.png")).toEqual({
      text: "newer edits /tmp/image.png ",
      caret: 27,
    });
    expect(readTerminalComposerDraft(key)).toBe("newer edits /tmp/image.png ");

    clearTerminalComposerDraft(key);
  });

  test("uses the latest shared caret when an upload completes after remount", () => {
    const key = terminalComposerDraftKey("caret", 1, "p1");
    writeTerminalComposerDraft(key, "echo after");
    // A newly mounted textarea publishes its current selection under the same
    // draft key before an upload started by the prior mount completes.
    writeTerminalComposerSelection(key, 5, 5);

    expect(insertIntoTerminalComposerDraft(key, "/tmp/image.png")).toEqual({
      text: "echo /tmp/image.png after",
      caret: 20,
    });
    expect(readTerminalComposerSelection(key)).toEqual({ start: 20, end: 20 });

    clearTerminalComposerDraft(key);
    expect(readTerminalComposerSelection(key)).toBeNull();
  });

  test("retires drafts, submissions, uploads, and stale writes on scope changes", () => {
    const first = terminalComposerDraftKey("conn-a", 1, "p1");
    const second = terminalComposerDraftKey("conn-b", 2, "p1");
    activateTerminalComposerDraftScope("conn-a", 1);
    writeTerminalComposerDraft(first, "secret command");
    expect(beginTerminalComposerSubmission(first)).toBe(true);
    expect(beginTerminalComposerUpload(first)).toBe(true);

    activateTerminalComposerDraftScope("conn-b", 2);

    expect(readTerminalComposerDraft(first)).toBe("");
    expect(terminalComposerSubmissionPending(first)).toBe(false);
    expect(terminalComposerUploadCount(first)).toBe(0);
    writeTerminalComposerDraft(first, "restored by stale failure");
    expect(insertIntoTerminalComposerDraft(first, "/tmp/stale.png")).toEqual({
      text: "",
      caret: 0,
    });
    expect(readTerminalComposerDraft(first)).toBe("");

    writeTerminalComposerDraft(second, "current draft");
    expect(readTerminalComposerDraft(second)).toBe("current draft");
    clearTerminalComposerDraft(second);
  });

  test("pane closure retires async work for that draft key", () => {
    const key = terminalComposerDraftKey("conn-b", 2, "closing-pane");
    writeTerminalComposerDraft(key, "draft");
    expect(beginTerminalComposerSubmission(key)).toBe(true);
    expect(beginTerminalComposerUpload(key)).toBe(true);

    clearTerminalComposerDrafts("conn-b", 2, ["closing-pane"]);

    expect(terminalComposerSubmissionPending(key)).toBe(false);
    expect(terminalComposerUploadCount(key)).toBe(0);
    expect(beginTerminalComposerSubmission(key)).toBe(false);
    expect(beginTerminalComposerUpload(key)).toBe(false);
    expect(insertIntoTerminalComposerDraft(key, "/tmp/stale.png")).toEqual({
      text: "",
      caret: 0,
    });
  });

  test("close warning matches the draft count", () => {
    expect(terminalComposerCloseWarning(0)).toBe("");
    expect(terminalComposerCloseWarning(1)).toBe(
      " The unsent composer draft will be discarded.",
    );
    expect(terminalComposerCloseWarning(3)).toBe(
      " 3 unsent composer drafts will be discarded.",
    );
  });
});

describe("terminal composer request", () => {
  test("inserts text without any keys when not submitting", () => {
    const request = terminalComposerRequest("p3", "echo 你好", false);
    expect(request.method).toBe("pane.send_input");
    expect(request.params).toEqual({
      pane_id: "p3",
      text: "echo 你好",
      keys: [],
    });
  });

  test("sends exactly one enter key when submitting", () => {
    const request = terminalComposerRequest("p3", "ls", true);
    expect(request.params.keys).toEqual(["enter"]);
  });

  test("normalizes newlines like terminal paste", () => {
    const request = terminalComposerRequest("p3", "one\r\ntwo\nthree", true);
    expect(request.params.text).toBe("one\rtwo\rthree");
  });

  test("an uploaded image gets time to attach before Enter", async () => {
    const calls: unknown[] = [];
    const waits: number[] = [];
    const client = {
      call: async (method: string, params: unknown) => {
        calls.push([method, params]);
      },
    } as Parameters<typeof sendTerminalComposerText>[0];
    const path = "/tmp/roamgate-uploads-501/upload-abc/img-1.png";
    await sendTerminalComposerText(
      client,
      "p3",
      `${path} look`,
      true,
      async (ms) => {
        waits.push(ms);
        calls.push("wait");
      },
    );
    expect(calls).toEqual([
      ["pane.send_input", { pane_id: "p3", text: `${path} look`, keys: [] }],
      "wait",
      ["pane.send_input", { pane_id: "p3", text: "", keys: ["enter"] }],
    ]);
    expect(waits[0]).toBeGreaterThan(0);

    // Plain text, or an image only typed in, goes in one request.
    calls.length = 0;
    await sendTerminalComposerText(client, "p3", "ls", true, async () => {
      calls.push("wait");
    });
    await sendTerminalComposerText(
      client,
      "p3",
      `${path} `,
      false,
      async () => {
        calls.push("wait");
      },
    );
    expect(calls).toEqual([
      ["pane.send_input", { pane_id: "p3", text: "ls", keys: ["enter"] }],
      ["pane.send_input", { pane_id: "p3", text: `${path} `, keys: [] }],
    ]);
  });
});

describe("terminal composer caret insertion", () => {
  const insert = (
    text: string,
    selectionStart: number,
    selectionEnd: number,
    insertion: string,
  ) =>
    terminalComposerInsertAtCaret(
      text,
      selectionStart,
      selectionEnd,
      insertion,
    );

  test("inserts into empty text with a trailing space", () => {
    expect(insert("", 0, 0, "/tmp/a.png")).toEqual({
      text: "/tmp/a.png ",
      caret: 11,
    });
  });

  test("pads around non-whitespace neighbors", () => {
    expect(insert("cat", 3, 3, "/tmp/a.png")).toEqual({
      text: "cat /tmp/a.png ",
      caret: 15,
    });
    expect(insert("|base64", 0, 0, "/tmp/a.png")).toEqual({
      text: "/tmp/a.png |base64",
      caret: 11,
    });
    expect(insert("echo hi", 4, 4, "/tmp/a.png")).toEqual({
      text: "echo /tmp/a.png hi",
      caret: 15,
    });
  });

  test("continued typing after an end insertion stays a separate word", () => {
    const inserted = insert("cat", 3, 3, "/tmp/a.png");
    expect(`${inserted.text}hello`).toBe("cat /tmp/a.png hello");
  });

  test("does not double up existing whitespace", () => {
    expect(insert("cat ", 4, 4, "/tmp/a.png")).toEqual({
      text: "cat /tmp/a.png ",
      caret: 15,
    });
    expect(insert(" /tmp", 0, 0, "x.png")).toEqual({
      text: "x.png /tmp",
      caret: 5,
    });
  });

  test("replaces the current selection", () => {
    expect(insert("cat old.png now", 4, 11, "/tmp/new.png")).toEqual({
      text: "cat /tmp/new.png now",
      caret: 16,
    });
  });
});
