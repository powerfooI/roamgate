import { checkAnnotationUX } from "./annotations.browser";
import { roamgateLocalStorage } from "./browserStorage";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AgentMessageDialog } from "./components/AgentMessageDialog";
import { AgentSessionPreviewDialog } from "./components/AgentSessionPreviewDialog";
import { bridge, type ConnectionClient } from "./api";
import { __storeTesting, store } from "./store";
import type { FilePreview, Workspace } from "./types";
import {
  defaultShortcutBindings,
  detectShortcutPlatform,
} from "./shortcutBindings";
import {
  readResourceFileSelection,
  resourceScopeForWorkspace,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
} from "./workspaceResource";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/vendor.css";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
async function until(predicate: () => unknown, label: string) {
  void fetch("/event", { method: "POST", body: label });
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out: ${label}`);
}
const workspaces: Workspace[] = ["one", "two"].map((id, index) => ({
  workspace_id: id,
  number: index + 1,
  label: id,
  cwd: "/repo",
  focused: index === 0,
  pane_count: 0,
  tab_count: 0,
  agent_status: "idle",
}));
const pending = new Map<
  string,
  ReturnType<typeof Promise.withResolvers<FilePreview>>
>();
const fileNames = ["A.md", "B.md", "C.md", "alias.md"];
function response(path: string, workspaceId = "one"): FilePreview {
  return {
    workspace_id: workspaceId,
    root: "/repo",
    checkout_path: "/repo",
    path: path === "alias.md" ? "real.md" : path,
    text: path.endsWith("A.md")
      ? "# A\n[B](B.md#section)\n[alias](alias.md#section)\n[root](/alias.md#section)\n[escape](../etc/passwd)\n![logo](/assets/logo.png)"
      : `# ${path}\n${"paragraph\n\n".repeat(80)}\n## Section\nTarget`,
    binary: false,
    size: 100,
    mtime_ms: 1,
    truncated: false,
  };
}
const client: ConnectionClient = {
  connectionId: "preview-test",
  generation: 1,
  serverRuntimeGeneration: 1,
  isCurrent: () => true,
  acceptsServerGeneration: (generation) => generation === 1,
  call: async (method, params = {}) => {
    const workspaceId = String(params.workspace_id ?? "one");
    const path = String(params.path ?? "");
    if (method === "file.read") {
      const deferred = Promise.withResolvers<FilePreview>();
      pending.set(`${workspaceId}:${path}`, deferred);
      return deferred.promise;
    }
    if (method === "file.list") {
      return {
        workspace_id: workspaceId,
        root: "/repo",
        checkout_path: "/repo",
        path,
        entries: fileNames.map((name) => ({
          name,
          path: name,
          type: "file",
          size: 100,
          mtime_ms: 1,
          hidden: false,
        })),
        truncated: false,
      };
    }
    if (method === "git.diff_summary") {
      return {
        workspace_id: workspaceId,
        root: "/repo",
        entries: [{ path: "A.md", kind: "unstaged", status: "M" }],
        counts: {},
      };
    }
    if (method === "git.diff_file") {
      return {
        workspace_id: workspaceId,
        root: "/repo",
        path,
        kind: params.kind,
        diff: "",
        truncated: false,
      };
    }
    return {};
  },
};
function request(path: string, workspaceId = "one") {
  const key = `${workspaceId}:${path}`;
  const result = pending.get(key);
  if (!result) throw new Error(`Missing request: ${key}`);
  pending.delete(key);
  return result;
}
function tree(path: string) {
  const row = [...document.querySelectorAll<HTMLElement>(".file-row")].find(
    (element) => element.querySelector(".file-name")?.textContent === path,
  );
  if (!row) throw new Error(`Missing tree row: ${path}`);
  flushSync(() => row.click());
}
function previewButton(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".file-preview-head-actions button",
    ),
  ].find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent === label,
  );
  if (!button) throw new Error(`Missing preview button: ${label}`);
  return button;
}
function refreshPreview() {
  const button = previewButton("Refresh preview");
  flushSync(() => button.click());
  check(button.disabled, "refresh remains enabled during its request");
}

function link(label: string) {
  const anchor = [
    ...document.querySelectorAll<HTMLAnchorElement>(".file-preview-markdown a"),
  ].find((element) => element.textContent === label);
  if (!anchor) throw new Error(`Missing link: ${label}`);
  flushSync(() => anchor.click());
}
function selected(workspace = workspaces[0]) {
  return readResourceFileSelection(
    roamgateLocalStorage,
    resourceScopeForWorkspace(client.connectionId, workspace),
  );
}
async function showA(path = "A.md") {
  if (path === "A.md") tree(path);
  else await quickOpen(path);
  request(path).resolve(response(path));
  await until(
    () =>
      document.querySelector(
        '.file-preview-markdown a[data-document-fragment="section"]',
      ),
    "A rendered",
  );
  const image = document.querySelector<HTMLImageElement>(
    '.file-preview-markdown img[alt="logo"]',
  );
  const imageUrl = new URL(image?.src ?? location.href);
  check(
    imageUrl.searchParams.get("path") === "assets/logo.png",
    `${path}: image lost workspace-root base`,
  );
  check(
    !imageUrl.searchParams.has("scope"),
    `${path}: image incorrectly uses filesystem scope`,
  );
  // A cached render can precede completion of its background read.
  await settle();
}
function commandMenuEvent() {
  // Match the platform preset: Meta+K on macOS, Ctrl+Alt+K elsewhere.
  const binding = defaultShortcutBindings(detectShortcutPlatform())[
    "command.menu"
  ][0];
  const parts = binding.split("+");
  return new KeyboardEvent("keydown", {
    key: parts[parts.length - 1].toLowerCase(),
    ctrlKey: parts.includes("Ctrl"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta"),
    shiftKey: parts.includes("Shift"),
    bubbles: true,
  });
}
async function quickOpen(path: string) {
  flushSync(() => window.dispatchEvent(commandMenuEvent()));
  await until(
    () =>
      document.querySelector<HTMLInputElement>(
        'input[placeholder="Search actions or enter file path..."]',
      ),
    "quick-open input",
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search actions or enter file path..."]',
  )!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, path);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await until(
    () =>
      [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].some((item) =>
        item.textContent?.includes("Open path:"),
      ),
    "quick-open result",
  );
  const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (element) => element.textContent?.includes("Open path:"),
  )!;
  flushSync(() => item.click());
  await until(() => pending.has(`one:${path}`), "quick-open request");
}

async function checkModalCopyFeedback() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const execCommand = document.execCommand;
  const layout = document.documentElement.dataset.layout;
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    for (const mode of ["desktop", "mobile"]) {
      document.documentElement.dataset.layout = mode;
      for (const session of [false, true]) {
        flushSync(() =>
          root.render(
            session ? (
              <AgentSessionPreviewDialog
                pane={{
                  pane_id: "p",
                  terminal_id: "t",
                  workspace_id: "one",
                  tab_id: "tab",
                  focused: true,
                  agent: "pi",
                  agent_status: "Idle",
                  revision: 1,
                }}
                summary={{
                  status: "ok",
                  agent: "pi",
                  pane_id: "p",
                  path: "/session.jsonl",
                  updated_at: "2026-01-01T00:00:00Z",
                  file: { size: 10 },
                  stats: { turns: 1, records: 1, token_usage: null },
                }}
                loading={false}
                error=""
                onClose={() => {}}
              />
            ) : (
              <AgentMessageDialog
                message={{
                  id: "copy-test",
                  role: "assistant",
                  text: "Copy fixture",
                  sent_at: "2026-01-01T00:00:00Z",
                }}
                onClose={() => {}}
              />
            ),
          ),
        );
        const label = session ? "Copy session file path" : "Copy message";
        for (const succeeds of [false, true]) {
          document.execCommand = () => succeeds;
          const button = document.querySelector<HTMLButtonElement>(
            `[aria-label="${label}"]`,
          )!;
          flushSync(() => button.click());
          await until(
            () =>
              document.querySelector(
                succeeds ? ".toast-success" : ".toast-error",
              ),
            "modal copy feedback rendered",
          );
          const toast = document.querySelector<HTMLElement>(
            succeeds ? ".toast-success" : ".toast-error",
          )!;
          check(
            mode !== "mobile" ||
              getComputedStyle(document.querySelector(".app")!).transform !==
                "none",
            "Mobile feedback must be tested with a transformed app stacking context",
          );
          check(
            toast.parentElement?.parentElement === document.body,
            `${mode}: toast must escape the app stacking context`,
          );
          const bounds = toast.getBoundingClientRect();
          check(
            toast.contains(
              document.elementFromPoint(
                bounds.left + bounds.width / 2,
                bounds.top + bounds.height / 2,
              ),
            ),
            `${mode} ${label}: feedback is hidden behind the modal`,
          );
          const dismiss = toast.querySelector<HTMLButtonElement>(
            '[aria-label="Dismiss notification"]',
          )!;
          const dismissBounds = dismiss.getBoundingClientRect();
          check(
            dismiss.contains(
              document.elementFromPoint(
                dismissBounds.left + dismissBounds.width / 2,
                dismissBounds.top + dismissBounds.height / 2,
              ),
            ),
            `${mode}: notification dismiss is blocked by the modal`,
          );
          flushSync(() => dismiss.click());
          check(
            document.querySelector(".modal-backdrop") !== null,
            "Dismissing feedback must not close the dialog",
          );
        }
      }
    }
  } finally {
    root.unmount();
    host.remove();
    document.execCommand = execCommand;
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (layout === undefined) delete document.documentElement.dataset.layout;
    else document.documentElement.dataset.layout = layout;
    flushSync(() => store.clearNotice());
  }
}

async function run() {
  void fetch("/event", { method: "POST", body: "fixture started" });
  // Only this disposable loopback page's storage and transport are used.
  store.init = () => {};
  bridge.connection = () => client;
  roamgateLocalStorage.setItem("diffViewMode", "split");
  roamgateLocalStorage.setItem("desktopDiffWrap", "false");
  roamgateLocalStorage.setItem("mobileDiffWrap", "true");
  __storeTesting.replaceState({
    ...store.get(),
    status: "connected",
    activeConnectionId: client.connectionId,
    connectionGeneration: 1,
    serverRuntimeGeneration: 1,
    lastRefresh: 1,
    workspaces,
    connections: [
      {
        id: client.connectionId,
        label: "Test",
        source: "test",
        is_default: true,
        state: "ready",
        generation: 1,
      },
    ],
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  flushSync(() => root.render(<App />));
  await settle();
  await checkModalCopyFeedback();
  flushSync(() =>
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_INSPECTOR_REQUEST_EVENT, {
        detail: {
          connectionId: client.connectionId,
          generation: 1,
          workspaceId: "one",
          view: "files",
        },
      }),
    ),
  );
  await until(() => document.querySelector(".file-row"), "file tree");

  await showA();
  await until(
    () => document.querySelector(".file-preview-changes-toggle"),
    "file changes available",
  );
  const inspector = document.querySelector<HTMLElement>(
    ".workspace-inspector",
  )!;
  const previousStyle = inspector.style.cssText;
  flushSync(() => previewButton("Changes").click());
  for (const width of [380, 900]) {
    inspector.style.cssText = `width:${width}px;min-width:${width}px;max-width:${width}px;flex-basis:${width}px`;
    await until(
      () => inspector.classList.contains("is-compact") === width < 640,
      "inspector width changed",
    );
    await until(
      () =>
        !!inspector.querySelector(".file-preview-changes .diff-content-view"),
      "embedded diff mounted",
    );
    const diff = inspector.querySelector<HTMLElement>(
      ".file-preview-changes .diff-content-view",
    )!;
    check(
      diff.classList.contains("is-mobile") === width < 640,
      "embedded Changes lost compact mode",
    );
    check(
      !!diff.querySelector(".diff-view-toggle") === width >= 640,
      "embedded Changes uses wrong view controls",
    );
    check(
      diff.querySelector(".diff-wrap-toggle")?.getAttribute("aria-pressed") ===
        String(width < 640),
      "embedded Changes uses the wrong wrap preference",
    );
  }
  inspector.style.cssText = previousStyle;
  flushSync(() => previewButton("Changes").click());
  await until(
    () => document.querySelector(".file-preview-markdown"),
    "return to preview",
  );

  // The reviewed bug: B starts from a link, then C starts in the tree. Check
  // both completion orders; B must not publish even while C is still loading.
  for (const olderFirst of [true, false]) {
    await showA();
    link("B");
    const b = request("B.md");
    tree("C.md");
    const c = request("C.md");
    if (olderFirst) {
      b.resolve(response("B.md"));
      await settle();
      check(
        selected() === "C.md",
        "older link replaced pending tree selection",
      );
      check(
        !document
          .querySelector(".file-preview-markdown")
          ?.textContent?.includes("B.md"),
        "older link rendered while newer tree pending",
      );
      c.resolve(response("C.md"));
    } else {
      c.resolve(response("C.md"));
      await settle();
      b.resolve(response("B.md"));
    }
    await settle();
    check(
      selected() === "C.md",
      `tree selection lost (olderFirst=${olderFirst})`,
    );
    check(
      document
        .querySelector(".file-preview-markdown")
        ?.textContent?.includes("C.md") === true,
      "newer tree content lost",
    );
  }

  // Reverse ownership: a pending tree read must not overwrite quick-open.
  tree("B.md");
  const oldTree = request("B.md");
  await quickOpen("/repo/A.md");
  request("/repo/A.md").resolve(response("/repo/A.md"));
  await settle();
  oldTree.resolve(response("B.md"));
  await settle();
  check(
    selected() === "/repo/A.md",
    "tree response replaced quick-open selection",
  );
  const escape = [
    ...document.querySelectorAll<HTMLAnchorElement>(".file-preview-markdown a"),
  ].find((anchor) => anchor.textContent === "escape");
  check(
    escape !== undefined && !escape.hasAttribute("href"),
    "absolute in-root base allowed workspace escape link",
  );

  // The requested alias is not the canonical response path. Observe the actual
  // heading scroll, then reopen the same alias in the tree without that fragment.
  const scrolled: string[] = [];
  const originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (options) {
    if (this.matches(".file-preview-markdown h2"))
      scrolled.push(this.textContent ?? "");
    originalScroll.call(this, options);
  };
  for (const label of ["alias", "root"]) {
    await showA("/repo/A.md");
    scrolled.length = 0;
    link(label);
    request("alias.md").resolve(response("alias.md"));
    await until(
      () => document.querySelector(".file-preview-markdown h2"),
      "canonical alias result",
    );
    await settle();
    check(
      scrolled.includes("Section"),
      `${label} fragment lost on canonical response`,
    );
    scrolled.length = 0;
    refreshPreview();
    request("alias.md").resolve(response("alias.md"));
    await until(
      () => scrolled.includes("Section"),
      "refresh preserves heading fragment",
    );
    scrolled.length = 0;
    tree("alias.md");
    request("alias.md").resolve(response("alias.md"));
    await settle();
    check(
      scrolled.length === 0,
      "old fragment reused by unrelated tree request",
    );
  }
  Element.prototype.scrollIntoView = originalScroll;

  // Header refresh bypasses cached content, preserves source mode, and can retry.
  await showA();
  refreshPreview();
  request("A.md").resolve({ ...response("A.md"), text: "# Updated from disk" });
  await until(
    () =>
      document.querySelector(".file-preview-markdown h1")?.textContent ===
      "Updated from disk",
    "refreshed content",
  );
  check(selected() === "A.md", "refresh changed the selected file");
  flushSync(() => previewButton("Source mode").click());
  await until(() => document.querySelector(".cm-content"), "raw content");
  refreshPreview();
  request("A.md").resolve({ ...response("A.md"), text: "# Updated source" });
  await until(
    () =>
      document
        .querySelector(".cm-content")
        ?.textContent?.includes("Updated source"),
    "refreshed raw content",
  );
  check(
    previewButton("Source mode").getAttribute("aria-checked") === "true",
    "refresh lost source mode",
  );
  refreshPreview();
  request("A.md").reject(new Error("file disappeared"));
  await until(
    () =>
      document
        .querySelector(".file-preview .is-error")
        ?.textContent?.includes("file disappeared"),
    "refresh error",
  );
  check(
    !previewButton("Refresh preview").disabled,
    "failed refresh cannot retry",
  );
  refreshPreview();
  request("A.md").resolve(response("A.md"));
  await until(() => document.querySelector(".cm-content"), "retry content");
  flushSync(() => previewButton("Source mode").click());
  await until(
    () => document.querySelector(".file-preview-markdown a"),
    "rendered after retry",
  );

  for (const olderFirst of [true, false]) {
    await showA();
    refreshPreview();
    const oldRefresh = request("A.md");
    tree("C.md");
    const current = request("C.md");
    if (olderFirst) {
      oldRefresh.resolve(response("A.md"));
      await settle();
      check(selected() === "C.md", "refresh replaced a pending tree selection");
      current.resolve(response("C.md"));
    } else {
      current.resolve(response("C.md"));
      await settle();
      oldRefresh.resolve(response("A.md"));
    }
    await settle();
    check(selected() === "C.md", "late refresh replaced the selected file");
    check(
      document.querySelector(".file-preview-markdown h1")?.textContent ===
        "C.md",
      "late refresh rendered over the selected file",
    );
  }

  // Stale failures cannot remove a newer result; newest failures remain visible.
  await showA();
  link("B");
  const staleFailure = request("B.md");
  tree("C.md");
  request("C.md").resolve(response("C.md"));
  staleFailure.reject(new Error("stale failure"));
  await settle();
  check(
    !document.body.textContent?.includes("stale failure"),
    "stale link failure surfaced",
  );
  await quickOpen("/repo/missing.md");
  request("/repo/missing.md").reject(new Error("newest failure"));
  await until(
    () => document.body.textContent?.includes("newest failure"),
    "newest error",
  );
  check(
    selected() === "/repo/missing.md",
    "newest failed selection was not retained",
  );

  await showA();
  link("B");
  const retiredWorkspace = request("B.md");
  __storeTesting.replaceState({
    ...store.get(),
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      focused: workspace.workspace_id === "two",
    })),
  });
  flushSync(() => store.clearNotice());
  await settle();
  retiredWorkspace.resolve(response("B.md"));
  await settle();
  check(
    selected(workspaces[1]) !== "B.md",
    "retired workspace request persisted under new workspace",
  );
  check(
    !document
      .querySelector(".file-preview-markdown")
      ?.textContent?.includes("B.md"),
    "retired workspace request rendered",
  );
  root.unmount();
  element.remove();
  await checkAnnotationUX(check);
}

void (
  new URLSearchParams(location.search).has("annotations-only")
    ? checkAnnotationUX(check)
    : run()
)
  .catch((error) =>
    failures.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
  )
  .finally(async () => {
    await fetch("/result", { method: "POST", body: JSON.stringify(failures) });
  });
