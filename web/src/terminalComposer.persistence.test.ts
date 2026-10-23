import { afterEach, expect, test } from "bun:test";
import type { ConnectionSummary } from "./api";

type Drafts = typeof import("./terminalComposer");
let moduleId = 0;
const freshDrafts = (): Promise<Drafts> =>
  import(`./terminalComposer.ts?draft-persistence-${++moduleId}`);
const originals = ["localStorage", "sessionStorage"].map(
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
  return drafts.terminalComposerDraftKey(host.id, generation, target.pane_id);
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
  const next = drafts.terminalComposerDraftKey(connection.id, 2, pane.pane_id);
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
  const restored = activate(drafts, 3, {
    ...connection,
    label: "Renamed",
    generation: 2,
  });
  expect(drafts.readTerminalComposerDraft(restored)).toBe("host A draft");
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

test("retired upload recovery cannot overwrite a current saved draft or revive a closed pane", async () => {
  const { local } = storage();
  const drafts = await freshDrafts();
  const oldKey = activate(drafts);
  drafts.writeTerminalComposerDraft(oldKey, "old text");
  const currentKey = activate(drafts, 2);
  drafts.writeTerminalComposerDraft(currentKey, "new text");
  drafts.retainTerminalComposerUploadPaths(oldKey, "/late.png");
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe("new text");
  storage(local);
  const reloaded = await freshDrafts();
  expect(reloaded.readTerminalComposerDraft(activate(reloaded))).toBe(
    "new text",
  );

  drafts.clearTerminalComposerDrafts(connection.id, 2, [pane.pane_id]);
  drafts.retainTerminalComposerUploadPaths(currentKey, "/closed.png");
  expect(drafts.readTerminalComposerDraft(currentKey)).toBe("");
  storage(local);
  const reopened = await freshDrafts();
  expect(reopened.readTerminalComposerDraft(activate(reopened))).toBe("");
});
