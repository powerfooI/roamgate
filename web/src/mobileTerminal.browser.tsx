import { Terminal } from "@xterm/xterm";
import {
  terminalSelectedText,
  TERMINAL_LONG_PRESS_MS,
} from "./terminalTouchSelection";
import {
  WORKSPACE_ANNOTATION_REQUEST_EVENT,
  type WorkspaceAnnotationRequest,
} from "./workspaceResource";
import { copyTextFromUserGesture } from "./terminalClipboard";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { bridge, type ConnectionClient, type TerminalPush } from "./api";
import { __storeTesting, store } from "./store";
import {
  initializeLayoutPreferences,
  updateLayoutPreferences,
} from "./layoutPreferences";
import { TerminalView } from "./components/TerminalView";
import type { Pane } from "./types";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout/app.css";

let holdParser = false;
const parserCallbacks: (() => void)[] = [];
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function (data, callback) {
  originalWrite.call(this, data, () => {
    if (holdParser && callback) parserCallbacks.push(callback);
    else callback?.();
  });
};
const releaseParser = () => {
  holdParser = false;
  for (const callback of parserCallbacks.splice(0)) callback();
};
const calls: { method: string; params: Record<string, unknown> }[] = [];
const listeners = new Set<(frame: TerminalPush) => void>();
let cols = 80,
  rows = 24;
let client: ConnectionClient = {
  connectionId: "mobile-test",
  generation: 1,
  serverRuntimeGeneration: 1,
  isCurrent: () => true,
  acceptsServerGeneration: () => true,
  call: async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "terminal.attach" || method === "terminal.resize") {
      cols = Number(params.cols);
      rows = Number(params.rows);
    }
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
const pane: Pane = {
  pane_id: "mobile-pane",
  terminal_id: "mobile-terminal",
  workspace_id: "workspace",
  tab_id: "tab",
  focused: true,
  agent_status: "idle",
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
  layout: {
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    zoomed: false,
    splits: [],
    area: { x: 0, y: 0, width: 80, height: 24 },
    focused_pane_id: pane.pane_id,
    panes: [
      {
        pane_id: pane.pane_id,
        focused: true,
        rect: { x: 0, y: 0, width: 80, height: 24 },
      },
    ],
  },
});
initializeLayoutPreferences();
updateLayoutPreferences({ mode: "mobile" });
const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0 0 60px;display:flex";
document.body.append(host);
host.className = "workspace-terminal-surface";
const root = createRoot(host);
const render = (showMobileKeys = false, uiScale = 100) =>
  flushSync(() =>
    root.render(
      <TerminalView
        terminalTheme={{ background: "#171922", foreground: "#dddddd" }}
        uiScale={uiScale}
        showMobileKeys={showMobileKeys}
      />,
    ),
  );
render();
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const frame = (text: string, mouse: boolean | null = true) => {
  const encoded = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < encoded.length; i += 8192)
    binary += String.fromCharCode(...encoded.subarray(i, i + 8192));
  const bytes = btoa(binary);
  for (const listener of listeners)
    listener({
      connection_id: client.connectionId,
      connection_generation: store.get().connectionGeneration,
      terminal_id: store.get().panes[0].terminal_id,
      bytes,
      full: true,
      width: cols,
      height: rows,
      ...(mouse === null ? {} : { mouse_reporting: mouse }),
      history: { top: 10, total: rows + 20, cols, rows, revision: 1 },
    });
};
const inputCalls = () =>
  calls.filter((call) =>
    ["terminal.input", "pane.send_input"].includes(call.method),
  );
const click = (selector: string) =>
  flushSync(() => document.querySelector<HTMLButtonElement>(selector)!.click());
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
const key = () =>
  textarea().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      bubbles: true,
      cancelable: true,
    }),
  );
const paste = () => {
  const data = new DataTransfer();
  data.setData("text/plain", "echo pasted");
  textarea().dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }),
  );
};
const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) {
    failures.push(message);
    console.error(message);
  }
};
let original: Element | null = null;
let lifecycle = 0;
let selectedOutput = "";
let annotationRequest: WorkspaceAnnotationRequest | null = null;
window.addEventListener(WORKSPACE_ANNOTATION_REQUEST_EVENT, (event) => {
  annotationRequest = (event as CustomEvent<WorkspaceAnnotationRequest>).detail;
});
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
let longPress: { id: number; activate: () => void } | null = null;
window.setTimeout = ((
  handler: TimerHandler,
  ms?: number,
  ...args: unknown[]
) => {
  if (ms !== TERMINAL_LONG_PRESS_MS || typeof handler !== "function")
    return realSetTimeout(handler, ms, ...args);
  const id = realSetTimeout(() => {}, 60_000);
  longPress = {
    id,
    activate: () => {
      realClearTimeout(id);
      handler();
    },
  };
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  if (longPress?.id === id) longPress = null;
  realClearTimeout(id as number);
};
const selectedText = () => {
  const clipboardData = new DataTransfer();
  document.querySelector(".xterm-screen")!.dispatchEvent(
    new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }),
  );
  return clipboardData.getData("text/plain");
};
const displayedText = () => document.querySelector(".xterm-rows")!.textContent!;
const checkEndHandleAlignment = () => {
  const selectedRows = Array.from(
    document.querySelectorAll(".xterm-selection div"),
  )
    .map((row) => row.getBoundingClientRect())
    .filter((row) => row.width > 0 && row.height > 0);
  const handle = document
    .querySelector('[aria-label="Selection end"]')!
    .getBoundingClientRect();
  const bottom = Math.max(...selectedRows.map((row) => row.bottom));
  const expected = Math.max(22, Math.min(bottom + 8, innerHeight - 22));
  check(
    selectedRows.length > 0 &&
      Math.abs(handle.top + handle.height / 2 - expected) <= 1,
    "end handle knob must meet the selected row bottom without a line-sized gap",
  );
};

let copiedOutput = "";
let readingWheelReports: string[] = [];
const keyboard = 'button[aria-label="Open device keyboard"]';

const point = (selector: string) => {
  const rect = document.querySelector(selector)!.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + Math.min(rect.height / 2, 80),
  };
};
const api = {
  failures,
  calls,
  point,
  cell(col: number, row = 0) {
    const rect = document
      .querySelector(".xterm-screen")!
      .getBoundingClientRect();
    return {
      x: rect.left + (col * rect.width) / cols,
      y: rect.top + ((row + 0.5) * rect.height) / rows,
    };
  },
  async activate() {
    check(!!longPress, "long press timer armed by trusted touch");
    longPress?.activate();
    longPress = null;
    await settle();
  },
  async ready() {
    await settle();
    frame(
      "\x1b[2J\x1b[H$ echo output\r\n  error: /repo/界é.ts\r\n\r\n  code();\x1b[?1000h\x1b[?1006h",
    );
    await settle();
    original = document.querySelector(".xterm");
    lifecycle = calls.filter((call) =>
      /terminal\.(attach|detach)/.test(call.method),
    ).length;
    check(!!original, "terminal mounted");
    for (const scale of [0.8, 1.25, 1]) {
      document.documentElement.style.zoom = String(scale);
      document.documentElement.style.setProperty("--ui-scale", String(scale));
      const target = document.querySelector(keyboard)!.getBoundingClientRect();
      check(
        target.width >= 43.9 && target.height >= 43.9,
        `${scale}: keyboard retains a 44px touch target`,
      );
    }
    for (const mode of ["desktop", "mobile"] as const) {
      updateLayoutPreferences({ mode });
      await settle();
      check(
        document.querySelector(keyboard)!.getBoundingClientRect().width >= 44,
        `${mode}: coarse-pointer keyboard button is available`,
      );
      check(
        document.querySelector(".xterm") === original,
        `${mode}: layout override keeps terminal instance`,
      );
    }
    frame(
      "\x1b[2J\x1b[H$ echo output\r\n  error: /repo/界é.ts\r\n\r\n  code();\x1b[?1000h\x1b[?1006h",
    );
    await settle();
    const rect = document.querySelector(keyboard)!.getBoundingClientRect();
    check(
      rect.width >= 44 &&
        rect.height >= 44 &&
        rect.bottom <= innerHeight - 60 &&
        rect.right <= innerWidth,
      "keyboard target above navigation and at least 44px",
    );
    check(
      !document.querySelector(".terminal-mobile-keys"),
      "keyboard available with shortcuts disabled",
    );
    check(
      document.activeElement !== textarea(),
      "initial reading does not focus input",
    );
  },
  async reading() {
    await settle();
    check(
      document.activeElement !== textarea(),
      "trusted reading tap never focuses xterm",
    );
    check(
      inputCalls().length === 0,
      "reading tap sends no input or mouse report",
    );
  },
  async readingWheel() {
    await settle();
    const reports = inputCalls();
    readingWheelReports = reports.map((call) => String(call.params.data));
    check(
      reports.some((call) =>
        /^\x1b\[<81;\d+;\d+M$/.test(atob(String(call.params.data))),
      ),
      "reading wheel preserves xterm coordinates and supported modifiers",
    );
    check(
      document.activeElement !== textarea() && textarea().readOnly,
      "reading wheel does not authorize or focus keyboard input",
    );
    calls.length = 0;
    key();
    paste();
    await settle();
    check(inputCalls().length === 0, "wheel leaves typing and paste blocked");
  },
  async typing() {
    check(
      document.activeElement === textarea(),
      "keyboard button synchronously focuses actual xterm textarea",
    );
    key();
    paste();
    await settle();
    check(
      inputCalls().some(
        (call) =>
          call.method === "terminal.input" &&
          call.params.terminal_id === "mobile-terminal",
      ),
      "typing reaches correct terminal",
    );
    check(
      inputCalls().some(
        (call) =>
          call.method === "pane.send_input" &&
          call.params.pane_id === "mobile-pane",
      ),
      "paste reaches correct pane",
    );
    textarea().value = "";
    textarea().dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    textarea().value = "界";
    textarea().dispatchEvent(
      new CompositionEvent("compositionupdate", { data: "界", bubbles: true }),
    );
    await settle();
    textarea().dispatchEvent(
      new CompositionEvent("compositionend", { data: "界", bubbles: true }),
    );
    await settle();
    check(
      inputCalls().filter(
        (call) =>
          call.method === "terminal.input" &&
          call.params.data ===
            btoa(String.fromCharCode(...new TextEncoder().encode("界"))),
      ).length === 1,
      "IME commit reaches terminal exactly once while input is active",
    );
    calls.length = 0;
  },
  async inputWheel() {
    await settle();
    check(
      JSON.stringify(inputCalls().map((call) => String(call.params.data))) ===
        JSON.stringify(readingWheelReports),
      "reading wheel reports match native xterm input-mode reports exactly",
    );
    calls.length = 0;
  },
  async scrolled() {
    await settle();
    check(
      document.activeElement === textarea(),
      "scroll does not dismiss keyboard input",
    );
    check(
      calls.some((call) => call.method === "terminal.scroll"),
      "touch scrolling preserves runtime scroll routing",
    );
    check(inputCalls().length === 0, "scroll emits no synthetic click report");
    check(
      !longPress && !document.querySelector(".terminal-selection-handle"),
      "scroll cancels pending long press",
    );
    calls.length = 0;
  },
  async dismissed() {
    await settle();
    frame("\x1b[H$ stable output\r\n  error: /repo/界é.ts\r\n\r\n  code();");
    await settle();
    check(
      document.activeElement !== textarea(),
      "dismiss tap blurs and frame does not refocus",
    );
    key();
    paste();
    textarea().dispatchEvent(
      new CompositionEvent("compositionend", { data: "stale", bubbles: true }),
    );
    textarea().dispatchEvent(
      new InputEvent("beforeinput", {
        data: "stale",
        inputType: "insertFromComposition",
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea().dispatchEvent(
      new InputEvent("input", {
        data: "stale",
        inputType: "insertFromComposition",
        bubbles: true,
      }),
    );
    await settle();
    check(
      inputCalls().length === 0,
      "dismiss tap and stale key/paste/IME send nothing",
    );
  },
  async selection() {
    await settle();
    check(
      !document.querySelector(".terminal-output-selection, pre"),
      "selection is directly in xterm, without snapshot page",
    );
    check(
      document.querySelectorAll(".terminal-selection-handle").length === 2,
      "long press exposes both handles",
    );
    selectedOutput = selectedText();
    checkEndHandleAlignment();
    check(
      selectedOutput === "stable",
      `long press selects a word: ${selectedOutput}`,
    );
    check(
      document.activeElement !== textarea() && textarea().readOnly,
      "long press revokes input without sending bytes",
    );
    const text = displayedText();
    frame("\x1b[2J\x1b[Hintermediate output");
    frame("\x1b[2J\x1b[Hreplacement output");
    await settle();
    check(
      displayedText() === text && selectedText() === selectedOutput,
      "endpoint streaming freezes the parsed displayed frame",
    );
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      for (const handle of document.querySelectorAll(
        ".terminal-selection-handle",
      )) {
        const rect = handle.getBoundingClientRect();
        check(
          rect.width >= 44 &&
            rect.height >= 44 &&
            rect.left >= 0 &&
            rect.right <= innerWidth,
          `${theme}: handles have onscreen 44px hit targets`,
        );
      }
    }
    document.addEventListener(
      "copy",
      (event) => {
        copiedOutput = window.getSelection()!.toString();
        event.preventDefault();
      },
      { once: true },
    );
  },
  async copied() {
    await settle();
    check(
      copiedOutput === selectedOutput && selectedText() === selectedOutput,
      "Copy copies exact text and retains terminal selection",
    );
    check(
      inputCalls().length === 0,
      "long press and copy emit no terminal input or reports",
    );
  },
  async dragged(expected: string) {
    await settle();
    checkEndHandleAlignment();
    check(
      selectedText() === expected,
      `drag endpoints including crossing: expected ${expected}, got ${selectedText()}`,
    );
  },
  async comment() {
    selectedOutput = selectedText();
    click(".terminal-touch-selection-actions button:nth-child(2)");
    await settle();
    check(
      document.activeElement?.getAttribute("aria-label") === "Review comment",
      "Add comment focuses existing quote editor",
    );
    const editor = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Review comment"]',
    )!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "Review selected output");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click('.annotation-composer-popover button[type="submit"]');
    await settle();
    check(
      annotationRequest?.annotation.quote === selectedOutput &&
        annotationRequest?.annotation.source === "terminal" &&
        annotationRequest?.annotation.paneId === "mobile-pane" &&
        annotationRequest?.workspaceId === "workspace",
      "comment preserves exact quote and validated source metadata",
    );
    check(
      !document.querySelector(".terminal-selection-handle") &&
        displayedText().includes("replacement output"),
      "save releases display hold and presents latest output",
    );
    check(
      !displayedText().includes("intermediate output"),
      "obsolete endpoint repaint is not presented",
    );
    check(
      document.activeElement !== textarea() && inputCalls().length === 0,
      "annotation never revives terminal input",
    );
    check(
      document.querySelector(".xterm") === original,
      "selection preserves xterm DOM identity",
    );
    check(
      !calls.some((call) => /terminal\.(attach|detach)/.test(call.method)),
      `selection retains attach (initial ${lifecycle})`,
    );
    render(true);
    await settle();
    check(
      !!document.querySelector(".terminal-mobile-keys-toggle .lucide-grid2x2"),
      "shortcut pad uses distinct icon",
    );
    click(keyboard);
    key();
    await settle();
    check(
      document.activeElement === textarea(),
      "keyboard can reopen after selection",
    );
    flushSync(() => {
      __storeTesting.replaceState({
        ...store.get(),
        panes: [
          { ...pane, pane_id: "next-pane", terminal_id: "next-terminal" },
        ],
        selectedPaneId: "next-pane",
        layout: {
          ...store.get().layout!,
          focused_pane_id: "next-pane",
          panes: [
            {
              pane_id: "next-pane",
              focused: true,
              rect: { x: 0, y: 0, width: 80, height: 24 },
            },
          ],
        },
      });
      store.clearNotice();
    });
    await settle();
    calls.length = 0;
    key();
    paste();
    await settle();
    check(
      document.activeElement !== textarea() && inputCalls().length === 0,
      "pane switch closes stale input route",
    );
    click(keyboard);
    key();
    paste();
    await settle();
    check(
      inputCalls().every((call) =>
        call.method === "terminal.input"
          ? call.params.terminal_id === "next-terminal"
          : call.params.pane_id === "next-pane",
      ),
      "reopened input targets only next pane",
    );
    flushSync(() => {
      __storeTesting.replaceState({
        ...store.get(),
        terminalAttachEpoch: store.get().terminalAttachEpoch + 1,
      });
      store.clearNotice();
    });
    await settle();
    calls.length = 0;
    key();
    paste();
    await settle();
    check(
      document.activeElement !== textarea() && inputCalls().length === 0,
      "reconnect invalidates active input",
    );
  },
  async regressions() {
    calls.length = 0;
    const screen = () => document.querySelector(".xterm-screen")!;
    const touch = (type: string, col = 2, row = 0, count = 1) => {
      const point = api.cell(col, row);
      const changed = new Touch({
        identifier: 1,
        target: screen(),
        clientX: point.x,
        clientY: point.y,
      });
      screen().dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          changedTouches: [changed],
          touches:
            type === "touchend" || type === "touchcancel"
              ? []
              : Array.from(
                  { length: count },
                  (_, index) =>
                    new Touch({
                      identifier: index + 1,
                      target: screen(),
                      clientX: point.x,
                      clientY: point.y,
                    }),
                ),
        }),
      );
    };
    const selectWord = async (col = 2, row = 0) => {
      touch("touchstart", col, row);
      await api.activate();
      touch("touchend", col, row);
      await settle();
    };
    const done = () =>
      click(".terminal-touch-selection-actions button:last-child");
    frame("\x1b[2J\x1b[Hcancel pending");
    await settle();
    for (const cancel of [
      () => touch("touchcancel"),
      () => touch("touchstart", 2, 0, 2),
      () => window.dispatchEvent(new Event("blur")),
    ]) {
      touch("touchstart");
      cancel();
      check(
        !longPress,
        "cancel, multitouch and blur cancel the long-press deadline",
      );
    }
    touch("touchend");
    holdParser = true;
    frame("\x1b[2J\x1b[Hparsed selected frame");
    await settle();
    touch("touchstart");
    await api.activate();
    check(
      !document.querySelector(".terminal-selection-handle"),
      "long press waits for the displayed parser callback",
    );
    frame("\x1b[2J\x1b[Hpending latest frame");
    releaseParser();
    await settle();
    touch("touchend");
    check(
      selectedText() === "parsed",
      "deferred long press selects the parsed frame, not pending output",
    );
    done();
    await settle();
    check(
      displayedText().includes("pending latest frame"),
      "Done releases pending endpoint frame",
    );

    const wrapped = `${"a".repeat(cols - 1)}界é🙂 tail`;
    frame(`\x1b[2J\x1b[H${wrapped}\r\n  code();`);
    await settle();
    await selectWord();
    const end = document.querySelector('[aria-label="Selection end"]')!;
    for (let i = 0; i < 2; i++)
      end.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    await settle();
    check(
      selectedText() === `${wrapped}\n  code();`,
      `selected copy preserves wrap filler, wide glyphs, combining marks, emoji and indentation: ${JSON.stringify(selectedText())}`,
    );
    checkEndHandleAlignment();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    check(
      !document.querySelector(".terminal-selection-handle") &&
        document.activeElement !== textarea(),
      "Escape exits selection without terminal focus",
    );

    frame("\x1b[2J\x1b[Hlegacy quote", null);
    await settle();
    await selectWord();
    const legacyVisible = displayedText();
    frame("\r\nfirst", null);
    frame(" second", null);
    await settle();
    check(
      displayedText() === legacyVisible,
      "incremental output freezes without replacing or dropping chunks",
    );
    done();
    await settle();
    check(
      displayedText().includes("first second"),
      "incremental output drains in original order",
    );
    frame("\x1b[2J\x1b[Hretained quote", null);
    await settle();
    await selectWord();
    click(".terminal-touch-selection-actions button:nth-child(2)");
    await settle();
    const editor = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Review comment"]',
    )!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "Keep this draft");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    frame("x".repeat(512 * 1024), null);
    frame("\r\nCAP END", null);
    await settle();
    await settle();
    check(
      document.querySelector('[aria-label="Review comment"]') === editor &&
        editor.value === "Keep this draft",
      "legacy cap preserves captured comment editor and draft",
    );
    check(
      store.get().notice?.message.includes("1 MiB") === true,
      "legacy cap explains automatic display resume",
    );
    frame("\r\nAFTER CAP", null);
    await settle();
    check(
      displayedText().includes("CAP END") &&
        displayedText().includes("AFTER CAP"),
      "cap trigger and subsequent live incremental output are retained",
    );
    click(".annotation-composer-popover button:first-child");
    await settle();

    frame("\x1b[2J\x1b[Hresize selected");
    await settle();
    await selectWord();
    const identity = document.querySelector(".xterm");
    host.style.right = "35px";
    await settle();
    check(
      !document.querySelector(".terminal-selection-handle") &&
        document.querySelector(".xterm") === identity,
      "resize clears touch geometry without recreating xterm",
    );
    host.style.right = "0";
    await settle();
    for (const scale of [0.8, 1.25, 1.5, 1]) {
      render(false, Math.round(scale * 100));
      document.documentElement.style.zoom = String(scale);
      document.documentElement.style.setProperty("--ui-scale", String(scale));
      frame("\x1b[2J\x1b[Hgeometry selected");
      await settle();
      await selectWord();
      checkEndHandleAlignment();
      for (const target of document.querySelectorAll(
        ".terminal-selection-handle, .terminal-touch-selection-actions button",
      )) {
        const rect = target.getBoundingClientRect();
        check(
          rect.width >= 43.9 &&
            rect.height >= 43.9 &&
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight,
          `${scale}: selection controls retain onscreen 44px geometry`,
        );
      }
      done();
    }
    for (const pause of [false, true]) {
      frame("\x1b[2J\x1b[Hlifecycle selected");
      await settle();
      await selectWord();
      flushSync(() => {
        __storeTesting.replaceState({
          ...store.get(),
          terminalAttachEpoch:
            store.get().terminalAttachEpoch + (pause ? 0 : 1),
          connectionPaused: pause,
        });
        store.clearNotice();
      });
      await settle();
      check(
        !document.querySelector(
          ".terminal-selection-handle, .terminal-touch-selection-actions, .terminal-annotation-action",
        ),
        `${pause ? "pause" : "reconnect"}: reset removes uncomposed annotation action`,
      );
      flushSync(() => {
        __storeTesting.replaceState({
          ...store.get(),
          connectionPaused: false,
        });
        store.clearNotice();
      });
      await settle();
    }
    holdParser = true;
    frame("\x1b[2J\x1b[Hstale deferred");
    await settle();
    touch("touchstart");
    await api.activate();
    flushSync(() => {
      __storeTesting.replaceState({
        ...store.get(),
        terminalAttachEpoch: store.get().terminalAttachEpoch + 1,
      });
      store.clearNotice();
    });
    releaseParser();
    await settle();
    touch("touchend");
    check(
      !document.querySelector(".terminal-selection-handle"),
      "reconnect cancels parser-deferred activation",
    );
    frame("\x1b[2J\x1b[Hroute selected", null);
    await settle();
    await selectWord();
    frame("OLD ROUTE PENDING", null);
    flushSync(() => {
      __storeTesting.replaceState({
        ...store.get(),
        panes: [
          { ...pane, pane_id: "third-pane", terminal_id: "third-terminal" },
        ],
        selectedPaneId: "third-pane",
        layout: {
          ...store.get().layout!,
          focused_pane_id: "third-pane",
          panes: [
            {
              pane_id: "third-pane",
              focused: true,
              rect: { x: 0, y: 0, width: 80, height: 24 },
            },
          ],
        },
      });
      store.clearNotice();
    });
    await settle();
    check(
      !displayedText().includes("OLD ROUTE PENDING"),
      "old pending chunks are discarded before new-route presentation",
    );
    frame("\x1b[2J\x1b[Hnew route");
    await settle();
    check(
      !document.querySelector(".terminal-selection-handle") &&
        !displayedText().includes("OLD ROUTE PENDING"),
      "route reset cannot leak a selected old terminal into the new pane",
    );
    check(
      inputCalls().length === 0 && document.activeElement !== textarea(),
      "selection lifecycle and deferred IME paths never authorize input",
    );

    frame("\x1b[2J\x1b[Hgeneration selected");
    await settle();
    await selectWord();
    client = { ...client, generation: client.generation + 1 };
    flushSync(() => {
      __storeTesting.replaceState({
        ...store.get(),
        connectionGeneration: client.generation,
      });
      store.clearNotice();
    });
    await settle();
    check(
      !document.querySelector(".terminal-selection-handle") &&
        document.activeElement !== textarea(),
      "connection generation invalidates touch selection and keyboard authorization",
    );
    original = document.querySelector(".xterm");
    const native = document.createElement("div");
    native.textContent = "native clipboard range";
    document.body.append(native);
    window
      .getSelection()!
      .setBaseAndExtent(native.firstChild!, 15, native.firstChild!, 0);
    const execCommand = document.execCommand;
    document.execCommand = () => true;
    try {
      await copyTextFromUserGesture("copied text");
    } finally {
      document.execCommand = execCommand;
    }
    check(
      window.getSelection()!.anchorOffset === 15 &&
        window.getSelection()!.focusOffset === 0 &&
        window.getSelection()!.toString() === "native clipboar",
      "clipboard fallback preserves a native backward range",
    );
    native.remove();
    calls.length = 0;
  },
  async hybrid() {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = matchMedia(query);
      if (query === "(pointer: coarse)")
        Object.defineProperty(result, "matches", { value: false });
      if (query === "(any-pointer: coarse)")
        Object.defineProperty(result, "matches", { value: true });
      return result;
    };
    Object.assign(api, {
      restoreMedia: () => {
        window.matchMedia = matchMedia;
      },
    });
    calls.length = 0;
  },
  async compatibilityMouse() {
    const screen = document.querySelector(".xterm-screen")!;
    const rect = screen.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
      screen.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "mousedown" ? 1 : 0,
          clientX: rect.left + 10,
          clientY: rect.top + 10,
        }),
      );
    }
    await settle();
    check(
      document.activeElement !== textarea() && inputCalls().length === 0,
      "hybrid touch compatibility mouse cannot focus or send input",
    );
  },
  async fineMouse() {
    check(
      document.activeElement === textarea(),
      "genuine fine mouse focuses in mobile layout after touch",
    );
    calls.length = 0;
    key();
    await settle();
    check(
      inputCalls().length > 0,
      "hybrid fine-mouse physical keyboard input works",
    );
    check(
      document.querySelector(keyboard)?.getAttribute("aria-pressed") === "true",
      "mouse input authorization activates the keyboard indicator",
    );
    textarea().blur();
    await settle();
    check(
      document.querySelector(keyboard)?.getAttribute("aria-pressed") ===
        "false" && textarea().readOnly,
      "blur clears the input indicator and authorization",
    );
    textarea().focus();
    calls.length = 0;
    key();
    await settle();
    check(
      document.activeElement === textarea() &&
        inputCalls().length > 0 &&
        document.querySelector(keyboard)?.getAttribute("aria-pressed") ===
          "true",
      "restored fine-mouse focus synchronizes input and its indicator",
    );
    check(
      document.querySelector(".xterm") === original,
      "hybrid modality changes retain xterm instance",
    );
  },
  async desktop() {
    const bufferHost = document.createElement("div");
    document.body.append(bufferHost);
    const bufferTerm = new Terminal({ cols: 5, rows: 2 });
    bufferTerm.open(bufferHost);
    for (const text of [
      "abcd界Z",
      "abc 界Z",
      "abc  界Z",
      "abcdeZ",
      "abcd界é🙂",
    ]) {
      bufferTerm.reset();
      await new Promise<void>((resolve) => bufferTerm.write(text, resolve));
      check(
        (bufferTerm.select(0, 0, 10), terminalSelectedText(bufferTerm)) ===
          text,
        `real xterm wrap preserves exact text: ${text}`,
      );
    }
    bufferTerm.dispose();
    bufferHost.remove();
    updateLayoutPreferences({ mode: "desktop" });
    await settle();
    frame("\x1b[2J\x1b[Hdesktop selection text", false);
    await settle();
    const screen = document.querySelector(".xterm-screen")!;
    const rect = screen.getBoundingClientRect();
    const mouse = (
      target: EventTarget,
      type: string,
      col: number,
      buttons: number,
      row = 0,
      altKey = false,
    ) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons,
          detail: 1,
          altKey,
          clientX: rect.left + (col * rect.width) / cols,
          clientY: rect.top + ((row + 0.5) * rect.height) / rows,
        }),
      );
    mouse(screen, "mousedown", 0.1, 1);
    mouse(document, "mousemove", 7.1, 1);
    mouse(document, "mouseup", 7.1, 0);
    await settle();
    const clipboardData = new DataTransfer();
    screen.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    check(
      clipboardData.getData("text/plain") === "desktop",
      "desktop mouse selection unchanged",
    );
    calls.length = 0;
    key();
    await settle();
    check(inputCalls().length > 0, "desktop typing unchanged");
    if (navigator.platform === "Linux x86_64") {
      frame("\x1b[2J\x1b[Habcdef\r\nghijkl\r\nmnopqr", false);
      await settle();
      mouse(screen, "mousedown", 1.1, 1, 0, true);
      mouse(document, "mousemove", 3.1, 1, 1, true);
      mouse(document, "mouseup", 3.1, 0, 1, true);
      await settle();
      const rectangleCopy = new DataTransfer();
      screen.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData: rectangleCopy,
        }),
      );
      check(
        rectangleCopy.getData("text/plain") === "bc\nhi",
        "desktop rectangular Copy contains only selected columns",
      );
      click(".terminal-annotation-action");
      await settle();
      const editor = document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Review comment"]',
      )!;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(editor, "Column review");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
      click('.annotation-composer-popover button[type="submit"]');
      await settle();
      check(
        annotationRequest?.annotation.quote === "bc\nhi",
        "desktop rectangular annotation contains only selected columns",
      );
    }
    root.unmount();
    return failures;
  },
};
Object.assign(window, { mobileTerminalTest: api });
