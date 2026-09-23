import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { bridge, type ConnectionClient, type TerminalPush } from "./api";
import { __storeTesting, store } from "./store";
import { selectShortcutPreset, updateShortcut } from "./shortcutPreferences";
import { detectShortcutPlatform } from "./shortcutBindings";
import {
  initializeLayoutPreferences,
  updateLayoutPreferences,
} from "./layoutPreferences";
import { TerminalView } from "./components/TerminalView";
import type { TerminalResolvedLink } from "./terminalLinkProvider";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout/app.css";

const failures: string[] = [];
const check = (value: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(value) !== JSON.stringify(expected))
    failures.push(`${label}: ${JSON.stringify(value)}`);
};
// Let React effects and xterm's queued render complete before observing the UI.
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const until = async (ready: () => boolean, label = "startup") => {
  const deadline = performance.now() + 6_000;
  while (performance.now() < deadline) {
    if (ready()) return;
    await settle();
  }
  throw new Error(
    `Terminal links fixture did not settle: ${label}; ${JSON.stringify(calls.slice(-6))}; menu=${document.querySelector("[role=menu]")?.textContent}`,
  );
};
const input = async (method: string, params: Record<string, unknown>) => {
  const response = await fetch("/input", {
    method: "POST",
    body: JSON.stringify({ method, params }),
  });
  if (!response.ok)
    throw new Error(`CDP ${method} failed (${response.status})`);
};
let term!: Terminal;
const terminals: Terminal[] = [];
let provider!: ILinkProvider;
const register = Terminal.prototype.registerLinkProvider;
Terminal.prototype.registerLinkProvider = function (value) {
  terminals.push(this);
  provider = value;
  return register.call(this, value);
};
const opened: string[] = [];
const activations: boolean[] = [];
window.open = ((url: string) => {
  opened.push(url);
  activations.push(navigator.userActivation.isActive);
  return null;
}) as typeof window.open;
const previews: string[] = [];
const calls: { method: string; params: Record<string, unknown> }[] = [];
const listeners = new Set<(frame: TerminalPush) => void>();
let target: TerminalResolvedLink | null = null;
let rpcRepaint: ((focus: boolean) => void) | null = null;
let held: Promise<TerminalResolvedLink | null> | null = null;
const heldRows = new Map<number, Promise<TerminalResolvedLink | null>>();
const endpoint = {
  generation: 1,
  serverVersion: "0.9.1",
  methods: [
    "pane.focus",
    "pane.scroll",
    "pane.link.resolve",
    "workspace.create",
  ],
  capabilities: [],
};
const client: ConnectionClient = {
  connectionId: "links-test",
  generation: 1,
  serverRuntimeGeneration: 1,
  isCurrent: () => true,
  acceptsServerGeneration: () => true,
  call: async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "terminal.attach") return { endpoint };
    if (method === "terminal.link.resolve") {
      rpcRepaint?.(false);
      return heldRows.get(params.row as number) ?? held ?? target;
    }
    if (method === "terminal.focus") rpcRepaint?.(true);
    if (method === "file.read")
      return {
        root: "/tmp",
        path: params.path,
        type: params.path === "/tmp/docs" ? "directory" : "file",
        text: "preview",
        workspace_id: "workspace",
      };
    if (method === "file.resolve")
      return {
        files: (params.paths as string[])
          .filter((path) =>
            ["/tmp/docs", "./docs", "./example.txt", "/tmp/long/docs"].includes(
              path,
            ),
          )
          .map((path) => ({
            candidate: path,
            path: path.startsWith("./") ? `/tmp/${path.slice(2)}` : path,
          })),
      };
    return {};
  },
};
bridge.connection = () => client;
bridge.onTerminal = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const pane = {
  pane_id: "pane",
  terminal_id: "terminal",
  workspace_id: "workspace",
  tab_id: "tab",
  focused: true,
  agent_status: "idle" as const,
  revision: 1,
};
__storeTesting.replaceState({
  ...store.get(),
  status: "connected",
  activeConnectionId: client.connectionId,
  connectionGeneration: 1,
  serverRuntimeGeneration: 1,
  panes: [pane],
  selectedPaneId: pane.pane_id,
  endpointAvailability: { terminal: endpoint },
  layout: {
    workspace_id: "workspace",
    tab_id: "tab",
    zoomed: false,
    splits: [],
    area: { x: 0, y: 0, width: 80, height: 24 },
    focused_pane_id: "pane",
    panes: [
      {
        pane_id: "pane",
        focused: true,
        rect: { x: 0, y: 0, width: 80, height: 24 },
      },
    ],
  },
});
initializeLayoutPreferences();
const mobile = navigator.maxTouchPoints > 0;
updateLayoutPreferences({ mode: mobile ? "mobile" : "desktop" });
selectShortcutPreset("windows");
const host = document.createElement("div");
host.className = "workspace-terminal-surface";
// A nonzero split-pane origin must not be added to Herdr's pane-local cells.
host.style.cssText =
  "position:fixed;left:53px;right:17px;top:37px;bottom:40px;display:flex";
document.body.append(host);
const root = createRoot(host);
const render = (uiScale: number) =>
  flushSync(() =>
    root.render(
      <TerminalView
        paneId="pane"
        terminalTheme={{ background: "#171922", foreground: "#dddddd" }}
        uiScale={uiScale}
        showMobileKeys={false}
        onOpenWorkspaceFile={(request) => previews.push(request.path)}
      />,
    ),
  );
let frameNumber = 0;
const pushFrame = (rows: string[], token?: string, cursor = "") => {
  const text =
    "\x1b[0m\x1b[2J\x1b[H\x1b[?7l" +
    rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join("") +
    "\x1b[?7h" +
    cursor;
  const bytes = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  for (const listener of listeners)
    listener({
      connection_id: client.connectionId,
      connection_generation: 1,
      terminal_id: "terminal",
      width: term.cols,
      height: term.rows,
      full: true,
      mouse_reporting: false,
      ...(token ? { link_frame: token } : {}),
      bytes,
    });
};
const frame = async (rows: string[], linkFrame = true) => {
  term.clearSelection();
  pushFrame(rows, linkFrame ? `frame-${++frameNumber}` : undefined);
  await settle();
};
const links = (row: number) =>
  new Promise<ILink[]>((done) =>
    provider.provideLinks(row, (value) => done(value ?? [])),
  );
const point = (row: number, col: number) => {
  const rect = term
    .element!.querySelector(".xterm-screen")!
    .getBoundingClientRect();
  return {
    x: rect.left + ((col + 0.5) * rect.width) / term.cols,
    y: rect.top + ((row + 0.5) * rect.height) / term.rows,
  };
};
const move = async (row: number, col: number) => {
  await input("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point(row, col),
    modifiers: 2,
  });
};
const hover = async (row: number, col: number) => {
  await input("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point(term.rows - 1, term.cols - 1),
    modifiers: 2,
  });
  await input("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point(row, col),
    modifiers: 2,
  });
  await settle();
};
const click = async (row: number, col: number, rehover = true) => {
  if (rehover) await hover(row, col);
  for (const type of ["mousePressed", "mouseReleased"])
    await input("Input.dispatchMouseEvent", {
      type,
      ...point(row, col),
      button: "left",
      clickCount: 1,
      modifiers: 2,
    });
  await settle();
};

const incremental = async (text: string) => {
  for (const listener of listeners)
    listener({
      connection_id: client.connectionId,
      connection_generation: 1,
      terminal_id: "terminal",
      width: term.cols,
      height: term.rows,
      full: false,
      bytes: btoa(text),
    });
  await settle();
};
const previewMenu = async (label: string) => {
  await until(() => !!document.querySelector("[role=menu]"), label);
  document.querySelector<HTMLButtonElement>("[role=menuitem]")!.click();
  await settle();
};

const action = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === label,
  );
const touch = (type: string, points: { x: number; y: number }[] = []) =>
  input("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, id) => ({ ...p, id })),
  });
const tap = async (element: Element) => {
  const rect = element.getBoundingClientRect();
  await touch("touchStart", [
    { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  ]);
  await touch("touchEnd");
  await settle();
};
const press = async (row: number, col: number) => {
  await touch("touchStart", [point(row, col)]);
  await new Promise((done) => setTimeout(done, 500));
  await touch("touchEnd");
  await settle();
};
const done = async () => {
  if (action("Done")) await tap(action("Done")!);
};

async function runTouch() {
  check(
    matchMedia("(pointer: coarse)").matches,
    true,
    "genuine coarse touch device",
  );
  let trusted = false;
  host.addEventListener(
    "touchstart",
    (event) => {
      trusted = event.isTrusted;
    },
    { capture: true },
  );
  const initialInput = calls.filter(
    (c) => c.method === "terminal.input",
  ).length;
  for (const scale of [100, 125]) {
    render(scale);
    await settle();
    const url = "https://x.test/a?b=c";
    target = null;
    await frame(["", `界e\u0301 ${url}`]);
    await press(1, 10);
    await until(() => !!action("Open link"), "touch web action");
    check(trusted, true, "trusted touch starts selection");
    check(
      document.querySelectorAll(".terminal-selection-handle").length,
      2,
      "link selection keeps both handles",
    );
    const count = opened.length;
    await tap(action("Open link")!);
    check(opened.length, count + 1, "only explicit action opens URL");
    check(opened.slice(-1)[0], url, `original cell URL at ${scale}%`);
    check(
      activations.slice(-1)[0],
      true,
      "open runs synchronously in user activation",
    );

    const wrapped = `https://example.org/${"a".repeat(term.cols)}/guide`;
    const rows = ["", wrapped.slice(0, term.cols), wrapped.slice(term.cols)];
    target = {
      url: wrapped,
      regions: [
        { row: 1, start_col: 0, end_col: term.cols - 1 },
        { row: 2, start_col: 0, end_col: rows[2]!.length - 1 },
      ],
    };
    await frame(rows);
    await press(2, 3);
    await until(() => !!action("Open link"), "wrapped touch URL");
    await tap(action("Open link")!);
    check(opened.slice(-1)[0], wrapped, "wrapped target not selected word");
    check(
      calls.filter((c) => c.method === "terminal.link.resolve").slice(-1)[0]
        ?.params.col,
      3,
      "touch probes original cell only",
    );
  }
  render(100);
  await settle();
  // Explicit frame targets work even without the optional plain-link resolver.
  endpoint.methods.splice(endpoint.methods.indexOf("pane.link.resolve"), 1);
  for (const uri of [
    "https://example.org/hidden",
    "file://localhost/tmp/docs",
    "javascript:alert(1)",
    "file://example.com/tmp/docs",
    "https://example.org/hidden\ninvalid",
  ]) {
    target = { uri, url: null, regions: [] };
    await frame([
      "",
      `\x1b]8;;${uri}\x1b\\https://label.example\x1b]8;;\x1b\\`,
    ]);
    await press(1, 10);
    if (uri === "https://example.org/hidden") {
      await until(() => !!action("Open link"), "OSC8 touch action");
      await tap(action("Open link")!);
      check(opened.slice(-1)[0], uri, "OSC8 target differs from label");
    } else if (uri.startsWith("file://localhost")) {
      await until(() => !!action("File actions"), "OSC8 directory touch");
      await tap(action("File actions")!);
      await until(() => !!action("Preview directory"), "directory preview");
      await tap(action("Preview directory")!);
      check(
        previews.slice(-1)[0],
        "/tmp/docs",
        "OSC8 directory uses workspace preview",
      );
    } else {
      check(
        !!action("Open link") || !!action("File actions"),
        false,
        "unsafe OSC8 suppresses URL label",
      );
      await done();
    }
  }
  target = null;
  for (const path of ["./example.txt", "./docs", "/tmp/docs/guide.md"]) {
    await frame(["", path]);
    await press(1, 4);
    await until(() => !!action("File actions"), "path touch action");
    await tap(action("File actions")!);
    await until(
      () => !!action(path === "./docs" ? "Preview directory" : "Preview file"),
      "path menu",
    );
    if (path === "./docs") {
      await until(
        () => !!action("Open directory as workspace..."),
        "directory workspace action",
      );
      await tap(action("Open directory as workspace...")!);
      const dialog = document.querySelector('[aria-label="Create workspace"]')!;
      check(
        [...dialog.querySelectorAll("input")].map((e) => e.value),
        ["docs", "/tmp/docs"],
        "touch workspace prefill",
      );
      await tap(action("Cancel")!);
    } else {
      await tap(action("Preview file")!);
      check(
        previews.slice(-1)[0],
        path.startsWith("./") ? "/tmp/example.txt" : path,
        "touch file preview path",
      );
    }
  }
  // Indented continuation retains the whole resolved path, not a word fragment.
  await frame(["", "/tmp/long/", "   docs"]);
  await press(2, 4);
  await until(() => !!action("File actions"), "indented path action");
  await tap(action("File actions")!);
  await until(() => !!action("Preview file"), "indented path menu");
  await tap(action("Preview file")!);
  check(previews.slice(-1)[0], "/tmp/long/docs", "indented path is complete");

  await frame(["", "https://example.org/test"]);
  const before = opened.length;
  for (const kind of ["tap", "move", "cancel", "multi"]) {
    await touch("touchStart", [point(1, 3)]);
    if (kind === "move") await touch("touchMove", [point(4, 3)]);
    if (kind === "multi") await touch("touchStart", [point(1, 3), point(2, 3)]);
    if (kind === "cancel") await touch("touchCancel");
    else await touch("touchEnd");
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      !!action("Open link") || !!action("Done"),
      false,
      `${kind} does not longpress`,
    );
  }
  check(opened.length, before, "short/canceled touches never open");
  check(
    calls.filter((c) => c.method === "terminal.input").length,
    initialInput,
    "link gestures never send terminal input",
  );

  for (const kind of [
    "normal release",
    "handle",
    "cancel",
    "multi",
    "scroll",
    "frame",
    "resize",
    "reconnect",
    "navigation",
  ]) {
    await frame(["", "https://example.org/test"]);
    let finish!: (value: TerminalResolvedLink) => void;
    held = new Promise((resolve) => {
      finish = resolve;
    });
    await press(1, 10);
    check(
      !!action("Done"),
      true,
      `selection appears before lookup completes (${kind})`,
    );
    if (kind === "handle") {
      const handle = document.querySelector('[aria-label="Selection end"]')!;
      const rect = handle.getBoundingClientRect();
      await touch("touchStart", [
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      ]);
      await touch("touchMove", [
        { x: rect.left + rect.width / 2 + 20, y: rect.top + rect.height / 2 },
      ]);
      await touch("touchEnd");
    }
    if (kind === "cancel" || kind === "multi" || kind === "scroll") {
      await touch("touchStart", [point(1, 10)]);
      if (kind === "cancel") await touch("touchCancel");
      if (kind === "multi") {
        await touch("touchStart", [point(1, 10), point(2, 10)]);
        await touch("touchEnd");
      }
      if (kind === "scroll") {
        await touch("touchMove", [point(4, 10)]);
        await touch("touchEnd");
      }
    }
    if (kind === "frame")
      pushFrame(["", "different output"], `frame-${++frameNumber}`);
    if (kind === "resize") term.resize(term.cols - 1, term.rows);
    if (kind === "navigation" || kind === "reconnect") {
      flushSync(() =>
        __storeTesting.replaceState({
          ...store.get(),
          ...(kind === "navigation"
            ? { layout: { ...store.get().layout!, tab_id: "other-tab" } }
            : { status: "disconnected" as const }),
        }),
      );
      render(100);
    }
    finish({
      url: "https://example.org/test",
      regions: [{ row: 1, start_col: 0, end_col: 23 }],
    });
    await settle();
    check(
      !!action("Open link"),
      kind === "normal release",
      `late result after ${kind}`,
    );
    if (!["resize", "navigation", "reconnect"].includes(kind))
      check(
        !!action("Copy") && !!action("Add comment"),
        true,
        "copy/comment retained",
      );
    held = null;
    await done();
    if (kind === "navigation" || kind === "reconnect") {
      flushSync(() =>
        __storeTesting.replaceState({
          ...store.get(),
          status: "connected",
          layout: { ...store.get().layout!, tab_id: "tab" },
        }),
      );
      render(100);
      await settle();
    }
  }
  check(
    calls.some((c) => c.method === "pane.link.activate"),
    false,
    "touch never invokes upstream activation",
  );
}

async function runNativeCopy() {
  await frame(["selected output"]);
  await until(
    () =>
      term.buffer.active.getLine(0)?.translateToString(true) ===
      "selected output",
    "copy selection rendered",
  );
  term.focus();
  term.select(0, 0, 15);
  const textarea = term.textarea!;
  let copyBlurs = 0;
  const onCopyBlur = () => copyBlurs++;
  textarea.addEventListener("blur", onCopyBlur);
  const apple = detectShortcutPlatform() === "mac";
  selectShortcutPreset(apple ? "mac" : "windows");
  updateShortcut("terminal.copy", [apple ? "Meta+C" : "Ctrl+C"]);
  const copyKey = new KeyboardEvent("keydown", {
    key: "c",
    code: "KeyC",
    keyCode: 67,
    metaKey: apple,
    ctrlKey: !apple,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(copyKey);
  check(
    copyKey.defaultPrevented,
    false,
    "native copy shortcut is not canceled",
  );
  check(copyBlurs, 0, "copy shortcut never blurs the IME textarea");
  textarea.removeEventListener("blur", onCopyBlur);
  const clipboardData = new DataTransfer();
  textarea.dispatchEvent(
    new ClipboardEvent("copy", {
      clipboardData,
      bubbles: true,
      cancelable: true,
    }),
  );
  check(
    clipboardData.getData("text/plain"),
    "selected output",
    "native copy payload",
  );
  check(
    document.activeElement === textarea && !textarea.readOnly,
    true,
    "copy keeps an editable terminal focused",
  );
  const inputBeforeCopy = calls.filter(
    (call) => call.method === "terminal.input",
  ).length;
  textarea.value = "";
  textarea.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  textarea.value = "\u4e2d\u6587";
  textarea.dispatchEvent(
    new CompositionEvent("compositionend", {
      bubbles: true,
      data: textarea.value,
    }),
  );
  await until(
    () =>
      calls.filter((call) => call.method === "terminal.input").length >
      inputBeforeCopy,
    "IME commit after copy",
  );
  check(
    calls
      .filter((call) => call.method === "terminal.input")
      .slice(inputBeforeCopy)
      .map((call) => call.params.data),
    [btoa(String.fromCharCode(...new TextEncoder().encode("\u4e2d\u6587")))],
    "IME commit after copy reaches the terminal once",
  );
  selectShortcutPreset("windows");
}

async function run() {
  render(100);
  await until(
    () =>
      terminals.length > 0 &&
      listeners.size > 0 &&
      calls.some((c) => c.method === "terminal.attach"),
  );
  term = terminals[terminals.length - 1]!;
  if (mobile) {
    await runTouch();
    return;
  }
  for (const scale of [100, 125]) {
    render(scale);
    await settle();
    const url = `https://example.com/${"a".repeat(term.cols * 2)}/guide`;
    const rows = [
      "",
      `界e\u0301 ${url.slice(0, term.cols - 4)}`,
      url.slice(term.cols - 4, term.cols * 2 - 4),
      url.slice(term.cols * 2 - 4),
    ];
    target = {
      url,
      regions: [
        { row: 1, start_col: 4, end_col: term.cols - 1 },
        { row: 2, start_col: 0, end_col: term.cols - 1 },
        { row: 3, start_col: 0, end_col: rows[3]!.length - 1 },
      ],
    };
    await frame([
      rows[0]!,
      `\x1b[31m${rows[1]}`,
      rows[2]!,
      `${rows[3]}\x1b[39m trailing text`,
    ]);
    check(
      [1, 2, 3].map((row) =>
        term.buffer.active
          .getLine(row)
          ?.getCell(row === 1 ? 4 : 0)
          ?.getFgColor(),
      ),
      [1, 1, 1],
      "wrapped links preserve the application's foreground on every row",
    );
    const underlined = () =>
      [...term.element!.querySelectorAll<HTMLElement>(".xterm-rows > div")].map(
        (row) =>
          [...row.querySelectorAll<HTMLElement>("span")]
            .filter((span) => span.style.textDecoration === "underline")
            .map((span) => span.textContent)
            .join(""),
      );
    for (const row of [1, 2, 3]) {
      const before = opened.length;
      await hover(row, row === 1 ? 6 : 2);
      check(opened.length, before, "hover never activates");
      check(
        underlined().filter(Boolean),
        [url.slice(0, term.cols - 4), rows[2], rows[3]],
        `all link rows underlined from row ${row} at scale ${scale}`,
      );
      await click(row, row === 1 ? 6 : 2, false);
      check(opened.length, before + 1, "each wrapped row remains clickable");
      check(opened[opened.length - 1], url, `wrapped target at scale ${scale}`);
    }
    await move(term.rows - 1, term.cols - 1);
    await settle();
    check(underlined().some(Boolean), false, "leaving clears every link row");
    check(
      (await links(2))[0]?.range.start.x,
      5,
      "wide/combining prefix uses cells",
    );
  }

  // Complete URLs must not depend on a remote region including prose, or on
  // a resolver reply that a live elapsed-time display keeps invalidating.
  render(100);
  await settle();
  for (const url of [
    "https://github.com/powerfool/roamgate/pull/252",
    "http://127.0.0.1:5175/",
  ]) {
    const text = `(${url}): merged.`;
    if (text.length >= term.cols - 1) continue;
    target = {
      url: `${url}):`,
      regions: [{ row: 1, start_col: 1, end_col: url.length + 2 }],
    };
    await frame(["", text]);
    const count = opened.length;
    await click(1, 5);
    check(opened.length, count + 1, "parenthesized URL remains clickable");
    check(opened[opened.length - 1], url, "prose is excluded from destination");
  }
  const liveUrl = "http://127.0.0.1:5175/";
  held = new Promise(() => {});
  for (let tick = 0; tick < 3; tick++) {
    await frame(["", `Local: ${liveUrl} (${tick}s)`]);
    const count = opened.length;
    await click(1, 10, tick === 0);
    check(
      opened.length,
      count + 1,
      "live URL survives timer repaint without rehover",
    );
    check(opened[opened.length - 1], liveUrl, "live URL target");
  }
  held = null;

  // Herdr 0.9.1 emits a full equivalent surface on resolve and on mouse-down
  // focus, even when the cursor owner is the only thing that changed.
  for (const native of [false, true]) {
    const url = "https://example.org/stable";
    const rows = [
      "",
      native ? `\x1b]8;;${url}\x1b\\Stable label\x1b]8;;\x1b\\` : url,
    ];
    const token = `frame-${++frameNumber}`;
    target = native
      ? null
      : {
          url,
          regions: [{ row: 1, start_col: 0, end_col: url.length - 1 }],
        };
    pushFrame(rows, token);
    await settle();
    for (const cursorOnly of [false, true]) {
      const cursor = cursorOnly ? "\x1b[0m\x1b[2;3H\x1b[1 q\x1b[?25h" : "";
      rpcRepaint = (focus) => pushFrame(rows, token, focus ? cursor : "");
      const probes = calls.filter(
        (c) => c.method === "terminal.link.resolve",
      ).length;
      await hover(1, 2);
      // Observe a full repaint-storm window, not just the first resolved frame.
      await new Promise((resolve) => setTimeout(resolve, 200));
      check(
        calls.filter((c) => c.method === "terminal.link.resolve").length -
          probes <=
          4,
        true,
        `${native ? "OSC8" : "plain"} hover does not cause RPC repaint storm`,
      );
      const count = opened.length;
      await input("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point(1, 2),
        button: "left",
        clickCount: 1,
        modifiers: 2,
      });
      // Wait for focus's real RPC side effect between down and up.
      await settle();
      await input("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point(1, 2),
        button: "left",
        clickCount: 1,
        modifiers: 2,
      });
      await settle();
      check(
        opened.length,
        count + 1,
        `${native ? "OSC8" : "plain"} click survives ${cursorOnly ? "cursor" : "identical"} focus surface`,
      );
      check(opened[opened.length - 1], url, "stable click target");
      rpcRepaint = null;
    }
  }

  // A modified click both selects an inactive split pane and activates its link.
  for (const kind of ["url", "OSC8 url", "file", "OSC8 file"]) {
    const file = kind.endsWith("file");
    const destination = file
      ? "/tmp/docs/guide.md"
      : "https://example.org/inactive";
    const label = kind.startsWith("OSC8")
      ? `\x1b]8;;${file ? "file://" : ""}${destination}\x1b\\Inactive link\x1b]8;;\x1b\\`
      : destination;
    target = null;
    await frame(["", label]);
    flushSync(() =>
      __storeTesting.replaceState({
        ...store.get(),
        layout: {
          ...store.get().layout!,
          panes: [
            ...store
              .get()
              .layout!.panes.filter((p) => p.pane_id !== "other-pane"),
            {
              pane_id: "other-pane",
              focused: false,
              rect: { x: 0, y: 0, width: 80, height: 24 },
            },
          ],
        },
      }),
    );
    flushSync(() => store.selectPane("other-pane"));
    await settle();
    await hover(1, 2);
    const count = opened.length;
    // Emit a real store subscription update during mouse-down, not just RPC output.
    host.addEventListener(
      "mousedown",
      () => flushSync(() => store.selectPane("pane")),
      { capture: true, once: true },
    );
    await click(1, 2, false);
    check(store.get().selectedPaneId, "pane", "click selects inactive pane");
    if (file) {
      await previewMenu(`${kind} first inactive-pane click`);
      check(
        previews[previews.length - 1],
        destination,
        "inactive-pane file target",
      );
    } else {
      check(opened.length, count + 1, `${kind} first inactive-pane click`);
      check(opened[opened.length - 1], destination, "inactive-pane URL target");
    }
  }

  // Neither the clipped head nor tail may turn a visible fragment into a target.
  for (const tail of [false, true]) {
    const row = tail ? term.rows - 1 : 0;
    const rows = Array.from({ length: term.rows }, () => "");
    rows[row] = tail
      ? `https://example.com/${"a".repeat(term.cols)}`.slice(0, term.cols)
      : "https://example.com/visible";
    target = {
      url: null,
      regions: [{ row, start_col: 0, end_col: rows[row]!.length - 1 }],
    };
    await frame(rows);
    check(
      (await links(row + 1)).length,
      0,
      tail ? "clipped tail" : "clipped head",
    );
  }

  target = null;
  await frame([
    "\x1b]8;;https://example.org/full-hidden-target\x1b\\short label\x1b]8;;\x1b\\",
  ]);
  check(
    term.buffer.active
      .getLine(term.buffer.active.viewportY)
      ?.translateToString(true),
    "short label",
    "OSC8 rendered label",
  );
  await click(0, 2);
  check(
    opened[opened.length - 1],
    "https://example.org/full-hidden-target",
    "OSC8 preserves destination despite partial label visibility",
  );
  check(
    calls.some((c) => c.method === "pane.link.activate"),
    false,
    "no upstream activation",
  );

  await frame(["", "/tmp/docs/guide.md"], false);
  check(
    term.buffer.active
      .getLine(term.buffer.active.viewportY + 1)
      ?.translateToString(true),
    "/tmp/docs/guide.md",
    "file rendered text",
  );
  check(
    (await links(2)).map((link) => link.text),
    ["/tmp/docs/guide.md"],
    "file provider links",
  );
  await click(1, 4);
  await until(() => !!document.querySelector("[role=menu]"), "file menu");
  const preview = document.querySelector<HTMLButtonElement>("[role=menuitem]")!;
  check(document.activeElement === preview, true, "file menu autofocus");
  await frame(["", "background program output"]);
  check(
    document.activeElement === preview,
    true,
    "output preserves file menu focus",
  );
  check(
    document.querySelector("[role=menuitem]") === preview,
    true,
    "output preserves captured file menu",
  );
  preview.click();
  await settle();
  check(
    previews[previews.length - 1],
    "/tmp/docs/guide.md",
    "existing file preview action",
  );
  check(
    document.activeElement === term.textarea,
    true,
    "menu restores terminal focus",
  );

  for (const directory of [
    "/tmp/docs",
    "\x1b]8;;file://localhost/tmp/docs\x1b\\Directory\x1b]8;;\x1b\\",
  ]) {
    await frame(["Directory location", directory, "next"], false);
    await click(1, 3);
    await until(
      () =>
        [...document.querySelectorAll("[role=menuitem]")].some((e) =>
          e.textContent?.includes("Open directory"),
        ),
      "directory menu",
    );
    await input("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
    check(
      document.activeElement?.textContent,
      "Open directory as workspace...",
      "keyboard menu navigation",
    );
    (document.activeElement as HTMLButtonElement).click();
    await settle();
    const dialog = document.querySelector('[aria-label="Create workspace"]')!;
    check(
      [...dialog.querySelectorAll("input")].map((e) => e.value),
      ["docs", "/tmp/docs"],
      "workspace dialog prefilled",
    );
    await input("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await settle();
  }

  await frame(
    ["", "\x1b]8;;file:///tmp/docs/guide%20one.md\x1b\\File\x1b]8;;\x1b\\"],
    false,
  );
  await click(1, 1);
  await until(() => !!document.querySelector("[role=menu]"), "OSC8 file menu");
  document.querySelector<HTMLButtonElement>("[role=menuitem]")!.click();
  await settle();
  check(
    previews[previews.length - 1],
    "/tmp/docs/guide one.md",
    "OSC8 local file is decoded for preview",
  );
  const openCount = opened.length;
  for (const uri of [
    "javascript:alert(1)",
    "file://example.com/tmp/docs",
    "data:text/html,ignored",
  ]) {
    await frame(["", `\x1b]8;;${uri}\x1b\\Unsafe\x1b]8;;\x1b\\`], false);
    await click(1, 1);
    check(
      !!document.querySelector("[role=menu]"),
      false,
      "unsafe URI does not open file actions",
    );
  }
  check(opened.length, openCount, "unsafe OSC8 schemes do not open a browser");

  // Stay on one row: xterm retains inactive row caches across repaints.
  for (const native of [true, false]) {
    const label = native
      ? "\x1b]8;;file:///tmp/old.md\x1b\\File\x1b]8;;\x1b\\"
      : "/tmp/old.md";
    const replacement = native
      ? "\x1b]8;;file:///tmp/new.md\x1b\\File\x1b]8;;\x1b\\"
      : "/tmp/new.md";
    await frame(["", label], false);
    await hover(1, 2);
    await move(1, 20);
    await incremental(`\x1b[2;1H\x1b[2K${replacement}`);
    await move(1, 2);
    await settle();
    await click(1, 2, false);
    await previewMenu(`${native ? "native" : "custom"} same-row repaint menu`);
    check(
      previews[previews.length - 1],
      "/tmp/new.md",
      "same-row repaint uses reread target",
    );
  }

  for (const kind of ["url", "file", "native"]) {
    const text =
      kind === "url"
        ? "https://static.example/guide"
        : kind === "file"
          ? "/tmp/static.md"
          : "\x1b]8;;file:///tmp/static.md\x1b\\Static\x1b]8;;\x1b\\";
    for (const change of ["other-row output", "no-op wheel"]) {
      await frame(["", text], false);
      await hover(1, 2);
      if (change === "other-row output")
        await incremental("\x1b[4;1Hunrelated");
      else {
        term.element!.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: 0 }),
        );
        await settle();
      }
      const count = opened.length;
      await click(1, 2, false);
      if (kind === "url") {
        check(opened.length, count + 1, `${kind} clickable after ${change}`);
        check(opened[opened.length - 1], text, "unchanged URL target");
      } else {
        await previewMenu(`${kind} clickable after ${change}`);
        check(
          previews[previews.length - 1],
          "/tmp/static.md",
          "unchanged file target",
        );
      }
    }
  }

  await hover(term.rows - 1, term.cols - 1);
  await frame(["", "https://a.example", "https://b.example"]);
  let finishA!: (value: TerminalResolvedLink | null) => void;
  let finishB!: (value: TerminalResolvedLink | null) => void;
  heldRows.set(
    1,
    new Promise((done) => {
      finishA = done;
    }),
  );
  heldRows.set(
    2,
    new Promise((done) => {
      finishB = done;
    }),
  );
  await hover(1, 2);
  await move(2, 2);
  await settle();
  finishB({
    url: "https://b.example",
    regions: [{ row: 2, start_col: 0, end_col: 16 }],
  });
  await settle();
  finishA({
    url: "https://a.example",
    regions: [{ row: 1, start_col: 0, end_col: 16 }],
  });
  await settle();
  heldRows.clear();
  await move(2, 20);
  await move(2, 2);
  await settle();
  const beforeOutOfOrderClick = opened.length;
  await click(2, 2, false);
  check(
    opened.length,
    beforeOutOfOrderClick + 1,
    "late row A reply preserves row B cache",
  );
  check(
    opened[opened.length - 1],
    "https://b.example",
    "out-of-order row target",
  );

  await hover(term.rows - 1, term.cols - 1);
  await frame(["", "https://example.com"]);
  let finish!: (value: TerminalResolvedLink) => void;
  held = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = links(2);
  await frame(["", "different output"]);
  finish({
    url: "https://example.com",
    regions: [{ row: 1, start_col: 0, end_col: 18 }],
  });
  check(await pending, [], "delayed link cannot survive a frame");
  held = null;

  for (const change of ["scroll", "resize"]) {
    await frame(["", "https://example.com"]);
    held = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = links(2);
    if (change === "scroll") {
      await input("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point(1, 3),
        deltaY: -60,
        deltaX: 0,
      });
      check(
        calls.some((call) => call.method === "terminal.scroll"),
        true,
        "wheel uses terminal transport",
      );
    } else {
      term.resize(term.cols - 1, term.rows);
    }
    finish({
      url: "https://example.com",
      regions: [{ row: 1, start_col: 0, end_col: 18 }],
    });
    check(await pending, [], `delayed link cannot survive ${change}`);
    held = null;
  }
  await runNativeCopy();
}
run()
  .catch((error: unknown) => failures.push(String(error)))
  .finally(() => {
    root.unmount();
    host.remove();
    void fetch("/result", { method: "POST", body: JSON.stringify(failures) });
  });
