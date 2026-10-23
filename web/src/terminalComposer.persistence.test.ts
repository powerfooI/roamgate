import { afterEach, expect, test } from "bun:test";
import type { ConnectionSummary } from "./api";

type Drafts = typeof import("./terminalComposer");
let moduleId = 0;
const freshDrafts = (): Promise<Drafts> =>
  import(`./terminalComposer.ts?draft-persistence-${++moduleId}`);
const originals = ["localStorage", "sessionStorage", "window"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

function storage(local = memoryStorage(), session = memoryStorage()) {
  for (const [key, value] of Object.entries({
    localStorage: local,
    sessionStorage: session,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return { local, session };
}

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const connection: ConnectionSummary = {
  id: "draft-host",
  label: "Host",
  source: "ssh-profile",
  type: "ssh",
  is_default: true,
  state: "ready",
  generation: 1,
  ssh_destination: "user@host",
  remote_control_socket_path: "/tmp/herdr.sock",
};
const pane = { pane_id: "pane-a", terminal_id: "terminal-a" };
function activate(
  drafts: Drafts,
  generation = 1,
  host = connection,
  target = pane,
) {
  drafts.activateTerminalComposerDraftScope(
    host.id,
    generation,
    [target],
    host,
  );
  return drafts.terminalComposerDraftKey(
    host.id,
    generation,
    target.pane_id,
    target.terminal_id,
  );
}

test("draft text survives a fresh page and a fresh browser session without sending", async () => {
  const { local, session } = storage();
  const first = await freshDrafts();
  first.writeTerminalComposerDraft(
    activate(first),
    "long message\nwith pasted text\n",
  );
  for (const nextSession of [session, memoryStorage()]) {
    storage(local, nextSession);
    const reopened = await freshDrafts();
    const key = activate(reopened, 8);
    expect(reopened.readTerminalComposerDraft(key)).toBe(
      "long message\nwith pasted text\n",
    );
    expect(reopened.terminalComposerSubmissionPending(key)).toBe(false);
  }
});

test("reconnect recovers text and notifies mounted inputs while retiring old work", async () => {
  storage();
  const drafts = await freshDrafts();
  const first = activate(drafts);
  drafts.writeTerminalComposerDraft(first, "keep me");
  drafts.beginTerminalComposerUpload(first);
  const next = drafts.terminalComposerDraftKey(
    connection.id,
    2,
    pane.pane_id,
    pane.terminal_id,
  );
  const observed: string[] = [];
  drafts.subscribeTerminalComposerDraft(next, (text) => observed.push(text));
  activate(drafts, 2);
  expect(observed).toEqual(["keep me"]);
  expect(drafts.readTerminalComposerDraft(first)).toBe("");
  expect(drafts.readTerminalComposerDraft(next)).toBe("keep me");
  drafts.writeTerminalComposerDraft(first, "stale text");
  drafts.writeTerminalComposerDraft(first, "");
  drafts.insertIntoTerminalComposerDraft(first, "/late-upload.png");
  expect(drafts.beginTerminalComposerSubmission(first)).toBe(false);
  expect(drafts.terminalComposerUploadCount(first)).toBe(0);
  expect(drafts.readTerminalComposerDraft(next)).toBe("keep me");
  const reload = await freshDrafts();
  expect(reload.readTerminalComposerDraft(activate(reload))).toBe("keep me");
});

test("recovery is isolated by destination, pane and terminal, not labels or generations", async () => {
  storage();
  const drafts = await freshDrafts();
  drafts.writeTerminalComposerDraft(activate(drafts), "host A draft");
  const restored = activate(drafts, 3, {
    ...connection,
    label: "Renamed",
    generation: 2,
  });
  expect(drafts.readTerminalComposerDraft(restored)).toBe("host A draft");
  for (const [host, target] of [
    [{ ...connection, id: "other-host" }, pane],
    [{ ...connection, ssh_destination: "user@other" }, pane],
    [{ ...connection, remote_control_socket_path: "/other.sock" }, pane],
    [connection, { ...pane, pane_id: "other-pane" }],
    [connection, { ...pane, terminal_id: "other-terminal" }],
  ] as const) {
    const isolated = activate(drafts, 2, host, target);
    expect(drafts.readTerminalComposerDraft(isolated)).toBe("");
  }
});

test("tab reload restores its own edits while reopening uses the last saved draft", async () => {
  const { local, session: sessionA } = storage();
  const first = await freshDrafts();
  first.writeTerminalComposerDraft(activate(first), "tab A");
  const sessionB = memoryStorage();
  storage(local, sessionB);
  const second = await freshDrafts();
  const secondKey = activate(second);
  expect(second.readTerminalComposerDraft(secondKey)).toBe("tab A");
  second.writeTerminalComposerDraft(secondKey, "tab B");
  expect(first.readTerminalComposerDraft(activate(first))).toBe("tab A");
  storage(local, sessionA);
  const reloadA = await freshDrafts();
  expect(reloadA.readTerminalComposerDraft(activate(reloadA))).toBe("tab A");
  reloadA.clearTerminalComposerDraft(activate(reloadA));
  storage(local);
  const otherTabBackup = await freshDrafts();
  expect(
    otherTabBackup.readTerminalComposerDraft(activate(otherTabBackup)),
  ).toBe("tab B");
  storage(local, sessionB);
  second.writeTerminalComposerDraft(secondKey, "new tab B");
  storage(local, sessionA);
  const clearedA = await freshDrafts();
  expect(clearedA.readTerminalComposerDraft(activate(clearedA))).toBe("");
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe(
    "new tab B",
  );
});

test("sending clears saved text, failed sends restore it, and closing discards it", async () => {
  const { local } = storage();
  const drafts = await freshDrafts();
  const key = activate(drafts);
  drafts.writeTerminalComposerDraft(key, "send me");
  await expect(
    drafts.submitTerminalComposerDraft(key, "send me", async () => {
      drafts.writeTerminalComposerDraft(key, " newer text");
      throw new Error("send failed");
    }),
  ).rejects.toThrow("send failed");
  storage(local);
  const failedReload = await freshDrafts();
  expect(failedReload.readTerminalComposerDraft(activate(failedReload))).toBe(
    "send me newer text",
  );
  await drafts.submitTerminalComposerDraft(
    key,
    "send me newer text",
    async () => {},
  );
  storage(local);
  const sentReload = await freshDrafts();
  expect(sentReload.readTerminalComposerDraft(activate(sentReload))).toBe("");
  drafts.writeTerminalComposerDraft(key, "discard me");
  drafts.clearTerminalComposerDrafts(connection.id, 1, [pane.pane_id]);
  storage(local);
  const closedReload = await freshDrafts();
  expect(
    closedReload.readTerminalComposerDraft(activate(closedReload, 2)),
  ).toBe("");
});

test("blocked storage retains edits and cleared drafts across reconnects", async () => {
  const { local, session } = storage();
  const setLocal = local.setItem;
  const drafts = await freshDrafts();
  const first = activate(drafts);
  drafts.writeTerminalComposerDraft(first, "saved before quota");
  for (const target of [local, session]) {
    target.setItem = () => {
      throw new Error("quota exceeded");
    };
  }
  drafts.writeTerminalComposerDraft(first, "new text");
  const next = activate(drafts, 2);
  expect(drafts.readTerminalComposerDraft(next)).toBe("new text");
  drafts.clearTerminalComposerDraft(next);
  expect(drafts.readTerminalComposerDraft(activate(drafts, 3))).toBe("");
  local.setItem = setLocal;
  drafts.clearTerminalComposerDraft(activate(drafts, 3));
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe("");
});

test("successful logout clears persisted drafts before navigating, failed logout keeps them", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const { logoutBrowserSession } = await import("./api");
  try {
    for (const status of [500, 204]) {
      const { local } = storage();
      const drafts = await freshDrafts();
      drafts.writeTerminalComposerDraft(activate(drafts), "private draft");
      let destination = "";
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: {
          replace: (url: string) => {
            destination = url;
          },
        },
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: async () => new Response(null, { status }),
      });
      if (status === 500)
        await expect(logoutBrowserSession()).rejects.toThrow(
          "Could not log out",
        );
      else await logoutBrowserSession();
      expect(destination).toBe(status === 204 ? "/login" : "");
      storage(local);
      const reopened = await freshDrafts();
      expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe(
        status === 204 ? "" : "private draft",
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("logout clears saved and live text without removing unrelated preferences", async () => {
  const { local } = storage();
  local.setItem("roamgate:theme", "dark");
  const drafts = await freshDrafts();
  const key = activate(drafts);
  drafts.writeTerminalComposerDraft(key, "secret draft");
  drafts.clearSavedTerminalComposerDrafts();
  expect(drafts.readTerminalComposerDraft(key)).toBe("");
  expect(local.getItem("roamgate:theme")).toBe("dark");
  const reload = await freshDrafts();
  expect(reload.readTerminalComposerDraft(activate(reload))).toBe("");
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe("");
});

test("logout invalidates a disconnected tab's saved and live drafts without a notification", async () => {
  const { local, session: sessionA } = storage();
  const first = await freshDrafts();
  first.writeTerminalComposerDraft(activate(first), "tab A secret");
  const sessionB = memoryStorage();
  storage(local, sessionB);
  const disconnected = await freshDrafts();
  const staleKey = activate(disconnected);
  disconnected.writeTerminalComposerDraft(staleKey, "tab B secret");
  disconnected.beginTerminalComposerUpload(staleKey);

  storage(local, sessionA);
  first.clearSavedTerminalComposerDrafts();
  storage(local, sessionB);
  const reloaded = await freshDrafts();
  expect(reloaded.readTerminalComposerDraft(activate(reloaded))).toBe("");
  reloaded.writeTerminalComposerDraft(activate(reloaded), "new login draft");

  // No storage event or WebSocket close was delivered to the old page.
  disconnected.writeTerminalComposerDraft(staleKey, "tab B secret edited");
  disconnected.retainTerminalComposerUploadPaths(staleKey, "/late-secret.png");
  expect(disconnected.readTerminalComposerDraft(staleKey)).toBe("");
  expect(disconnected.terminalComposerUploadCount(staleKey)).toBe(0);
  expect(disconnected.beginTerminalComposerSubmission(staleKey)).toBe(false);
  expect(
    disconnected.readTerminalComposerDraft(activate(disconnected, 2)),
  ).toBe("new login draft");
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe(
    "new login draft",
  );
});

test("logout prevents a pending send failure and upload from restoring cleared text", async () => {
  const { local } = storage();
  const drafts = await freshDrafts();
  const key = activate(drafts);
  drafts.writeTerminalComposerDraft(key, "secret");
  await expect(
    drafts.submitTerminalComposerDraft(key, "secret", async () => {
      drafts.clearSavedTerminalComposerDrafts();
      drafts.retainTerminalComposerUploadPaths(key, "/late-secret.png");
      throw new Error("logged out");
    }),
  ).rejects.toThrow("logged out");
  expect(drafts.readTerminalComposerDraft(key)).toBe("");
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe("");
});

test("upload recovery saves the inserted paths across reconnects, reloads and reopening", async () => {
  const { local, session } = storage();
  const drafts = await freshDrafts();
  const key = activate(drafts);
  drafts.writeTerminalComposerDraft(key, "look after");
  drafts.writeTerminalComposerSelection(key, 5, 5);
  drafts.retainTerminalComposerUploadPaths(key, "/first.png");
  drafts.retainTerminalComposerUploadPaths(key, "/second.png");
  const expected = "look /first.png /second.png after";
  expect(drafts.readTerminalComposerDraft(key)).toBe(expected);
  expect(drafts.readTerminalComposerDraft(activate(drafts, 2))).toBe(expected);
  for (const nextSession of [session, memoryStorage()]) {
    storage(local, nextSession);
    const reopened = await freshDrafts();
    const restoredKey = activate(reopened);
    expect(reopened.readTerminalComposerDraft(restoredKey)).toBe(expected);
    expect(reopened.terminalComposerSubmissionPending(restoredKey)).toBe(false);
  }
});

test("retired upload recovery appends to newer text without replacing the current selection", async () => {
  const { local } = storage();
  const drafts = await freshDrafts();
  const oldKey = activate(drafts);
  drafts.writeTerminalComposerDraft(oldKey, "old text");
  const currentKey = activate(drafts, 2);
  drafts.writeTerminalComposerDraft(currentKey, "new text");
  drafts.writeTerminalComposerSelection(currentKey, 0, 3);
  const observed: string[] = [];
  drafts.subscribeTerminalComposerDraft(currentKey, (text) =>
    observed.push(text),
  );
  drafts.retainTerminalComposerUploadPaths(oldKey, "/late.png");
  expect(observed).toEqual(["new text /late.png "]);
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe(
    "new text /late.png ",
  );
  storage(local);
  const reloaded = await freshDrafts();
  expect(reloaded.readTerminalComposerDraft(activate(reloaded))).toBe(
    "new text /late.png ",
  );

  drafts.clearTerminalComposerDrafts(connection.id, 2, [pane.pane_id]);
  drafts.retainTerminalComposerUploadPaths(oldKey, "/older-closed.png");
  drafts.retainTerminalComposerUploadPaths(currentKey, "/closed.png");
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe("");
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe("");
});

test("storage logout notifications immediately clear mounted drafts and stale session copies", async () => {
  const { local, session: sessionA } = storage();
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  const first = await freshDrafts();
  first.writeTerminalComposerDraft(activate(first), "first secret");
  const sessionB = memoryStorage();
  storage(local, sessionB);
  const second = await freshDrafts();
  const key = activate(second);
  second.writeTerminalComposerDraft(key, "second secret");
  const observed: string[] = [];
  second.subscribeTerminalComposerDraft(key, (text) => observed.push(text));

  storage(local, sessionA);
  first.clearSavedTerminalComposerDrafts();
  storage(local, sessionB);
  events.dispatchEvent(
    Object.assign(new Event("storage"), {
      key: "roamgate:terminalComposerLogout",
      storageArea: local,
    }),
  );
  // Check notification and storage before calling any composer read/write API.
  expect(observed).toEqual([""]);
  for (let i = 0; i < sessionB.length; i++) {
    expect(sessionB.getItem(sessionB.key(i)!)).not.toContain("secret");
  }
});

test("reloading a tab after logout erases its old session copies", async () => {
  const { local, session } = storage();
  const first = await freshDrafts();
  first.writeTerminalComposerDraft(activate(first), "old secret");
  storage(local);
  const otherTab = await freshDrafts();
  otherTab.clearSavedTerminalComposerDrafts();
  storage(local, session);
  const reloaded = await freshDrafts();
  expect(reloaded.readTerminalComposerDraft(activate(reloaded))).toBe("");
  for (let i = 0; i < session.length; i++) {
    expect(session.getItem(session.key(i)!)).not.toContain("old secret");
  }
});

test("late upload paths survive switching connections without reaching the other terminal", async () => {
  const { local } = storage();
  const drafts = await freshDrafts();
  const first = activate(drafts);
  drafts.writeTerminalComposerDraft(first, "original");
  const other = activate(drafts, 2, { ...connection, id: "other" });
  drafts.writeTerminalComposerDraft(other, "other terminal");
  drafts.retainTerminalComposerUploadPaths(first, "/partial.png");
  expect(drafts.readTerminalComposerDraft(other)).toBe("other terminal");
  expect(drafts.readTerminalComposerDraft(activate(drafts, 3))).toBe(
    "original /partial.png ",
  );
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe(
    "original /partial.png ",
  );
});

test("a missing topology preserves recovery but an observed pane removal retires every generation", async () => {
  const { local, session } = storage();
  const drafts = await freshDrafts();
  const oldKey = activate(drafts);
  drafts.writeTerminalComposerDraft(oldKey, "removed pane draft");
  drafts.activateTerminalComposerDraftScope(
    connection.id,
    2,
    undefined,
    connection,
  );
  drafts.retainTerminalComposerUploadPaths(oldKey, "/during-reconnect.png");
  const currentKey = activate(drafts, 2);
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe(
    "removed pane draft /during-reconnect.png ",
  );
  drafts.beginTerminalComposerUpload(currentKey);
  drafts.beginTerminalComposerSubmission(currentKey);
  const observed: string[] = [];
  drafts.subscribeTerminalComposerDraft(currentKey, (text) =>
    observed.push(text),
  );
  drafts.activateTerminalComposerDraftScope(connection.id, 2, [], connection);
  expect(observed).toEqual([""]);
  for (const key of [oldKey, currentKey]) {
    drafts.writeTerminalComposerDraft(key, "stale edit");
    drafts.retainTerminalComposerUploadPaths(key, "/after-close.png");
    expect(drafts.readTerminalComposerDraft(key)).toBe("");
    expect(drafts.beginTerminalComposerUpload(key)).toBe(false);
    expect(drafts.beginTerminalComposerSubmission(key)).toBe(false);
  }
  expect(drafts.terminalComposerUploadCount(currentKey)).toBe(0);
  expect(drafts.terminalComposerSubmissionPending(currentKey)).toBe(false);
  for (const nextSession of [session, memoryStorage()]) {
    storage(local, nextSession);
    const reopened = await freshDrafts();
    expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe("");
  }
});

test("a replacement terminal stays editable while callbacks for the previous terminal are retired", async () => {
  const { local } = storage();
  const drafts = await freshDrafts();
  const oldKey = activate(drafts);
  drafts.writeTerminalComposerDraft(oldKey, "previous terminal");
  drafts.beginTerminalComposerUpload(oldKey);
  const replacement = { ...pane, terminal_id: "replacement" };
  const currentKey = activate(drafts, 1, connection, replacement);
  expect(currentKey).not.toBe(oldKey);
  drafts.writeTerminalComposerDraft(currentKey, "replacement text");
  drafts.retainTerminalComposerUploadPaths(oldKey, "/old-terminal.png");
  expect(drafts.readTerminalComposerDraft(oldKey)).toBe("");
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe("replacement text");
  expect(
    drafts.terminalComposerDraftPaneIds(connection.id, 1, [pane.pane_id]),
  ).toEqual([pane.pane_id]);
  drafts.clearTerminalComposerDrafts(connection.id, 1, [pane.pane_id]);
  drafts.retainTerminalComposerUploadPaths(
    currentKey,
    "/closed-replacement.png",
  );
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe("");
  storage(local);
  const reopened = await freshDrafts();
  expect(
    reopened.readTerminalComposerDraft(
      activate(reopened, 1, connection, replacement),
    ),
  ).toBe("");
});

test.each(["confirmed", "observed"])(
  "%s pane closure clears a newer tab's backup and its missed session copy on reload",
  async (close) => {
    const { local, session: sessionA } = storage();
    const first = await freshDrafts();
    first.writeTerminalComposerDraft(activate(first), "tab A secret");
    const sessionB = memoryStorage();
    storage(local, sessionB);
    const second = await freshDrafts();
    second.writeTerminalComposerDraft(activate(second), "tab B secret");
    const storedKey = sessionB.key(0)!;

    storage(local, sessionA);
    if (close === "confirmed") {
      first.clearTerminalComposerDrafts(connection.id, 1, [pane.pane_id]);
    } else {
      first.activateTerminalComposerDraftScope(
        connection.id,
        1,
        [],
        connection,
      );
    }
    expect(local.getItem(storedKey)).toBe("");

    // The paused tab missed the removal and reloads without any live key mapping.
    storage(local, sessionB);
    expect(sessionB.getItem(storedKey)).toBe("tab B secret");
    const reload = await freshDrafts();
    reload.activateTerminalComposerDraftScope(
      connection.id,
      2,
      undefined,
      connection,
    );
    expect(sessionB.getItem(storedKey)).toBe("tab B secret");
    reload.activateTerminalComposerDraftScope(connection.id, 2, [], connection);
    expect(sessionB.getItem(storedKey)).toBe("");
    expect(local.getItem(storedKey)).toBe("");
  },
);

test("fresh topology clears only removed drafts from its own destination", async () => {
  const { local, session } = storage();
  const first = await freshDrafts();
  first.writeTerminalComposerDraft(activate(first), "removed secret");
  const removedStorageKey = session.key(0)!;
  const otherHost = { ...connection, id: "other-host" };
  first.writeTerminalComposerDraft(
    activate(first, 1, otherHost),
    "other draft",
  );
  const reload = await freshDrafts();
  reload.activateTerminalComposerDraftScope(connection.id, 2, [], connection);
  expect(session.getItem(removedStorageKey)).toBe("");
  expect(local.getItem(removedStorageKey)).toBe("");
  expect(reload.readTerminalComposerDraft(activate(reload, 2, otherHost))).toBe(
    "other draft",
  );
});
