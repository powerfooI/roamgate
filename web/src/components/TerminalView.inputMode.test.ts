import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { TerminalPush } from "../api";
import type { TerminalInputMode } from "../terminalInputMode";
import type { MobileTerminalShortcutRows } from "../mobileTerminalShortcuts";

// Real React commits are essential here: the safety and restore layout effects
// must run in order before Type's synchronous, user-gesture focus handoff.
// Keep module mocks out of the shared test runner and unrelated store tests.
if (process.env.ROAMGATE_INPUT_MODE_DOM_TEST !== "1") {
  test("terminal input preference regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_INPUT_MODE_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  await registerDomTests();
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    ResizeObserver: browser.ResizeObserver,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  // Exercise the phone input gate, even when the test runner has no touchscreen.
  browser.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
    onchange: null,
  })) as unknown as typeof browser.matchMedia;
  const { act, createElement, StrictMode } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const noop = () => {};
  const disposable = () => ({ dispose: noop });
  type Pane = {
    pane_id: string;
    terminal_id: string;
    workspace_id: string;
    tab_id: string;
    agent: string;
  };
  const paneA: Pane = {
    pane_id: "pane-a",
    terminal_id: "terminal-a",
    workspace_id: "workspace-a",
    tab_id: "tab-a",
    agent: "claude",
  };
  const paneB: Pane = {
    ...paneA,
    pane_id: "pane-b",
    terminal_id: "terminal-b",
  };
  const initialState = () => ({
    activeConnectionId: "connection-a",
    defaultConnectionId: "connection-a",
    connectionGeneration: 1,
    connectionPaused: false,
    connections: [{ id: "connection-a", generation: 1 }],
    layout: {
      tab_id: "tab-a",
      focused_pane_id: "pane-a",
      area: { x: 0, y: 0, width: 80, height: 24 },
      panes: [paneA, paneB].map((pane) => ({
        ...pane,
        rect: { x: 0, y: 0, width: 40, height: 24 },
      })),
    },
    panes: [paneA, paneB],
    selectedPaneId: "pane-a",
    status: "connected",
    terminalAttachEpoch: 0,
    endpointAvailability: {},
    error: "",
  });
  let state = initialState();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const clients = new Map<string, object>();
  const terminalListeners = new Set<(push: TerminalPush) => void>();
  let scrollDisabledReason: string | null = null;
  const scrollReason = mock(() => scrollDisabledReason);
  mock.module("../store", () => ({
    store: {
      get: () => state,
      terminalScrollReason: scrollReason,
      setTerminalEndpoint: noop,
      notify: noop,
      clearNotice: noop,
    },
    useStoreSelector: (selector: (value: typeof state) => unknown) =>
      selector(state),
    shallowEqual: Object.is,
    terminalNavigationLoading: () => false,
  }));
  mock.module("../api", () => ({
    bridge: {
      connection(id: string, runtime: number) {
        const generation = state.connectionGeneration;
        const key = `${id}:${generation}:${runtime}`;
        if (!clients.has(key)) {
          clients.set(key, {
            generation,
            isCurrent: () =>
              state.activeConnectionId === id &&
              state.connectionGeneration === generation &&
              state.connections.find((value) => value.id === id)?.generation ===
                runtime,
            acceptsServerGeneration: () => true,
            call: async (method: string, params: Record<string, unknown>) => {
              calls.push({ method, params });
              return {};
            },
          });
        }
        return clients.get(key);
      },
      onTerminal(callback: (push: TerminalPush) => void) {
        terminalListeners.add(callback);
        return () => terminalListeners.delete(callback);
      },
      onTerminalClipboard: () => noop,
      onTerminalClosed: () => noop,
    },
  }));
  mock.module("../layoutPreferences", () => ({
    isMobileLayout: () => true,
    LAYOUT_CHANGE_EVENT: "test-layout-change",
  }));
  mock.module("./CreateWorkspaceDialog", () => ({
    CreateWorkspaceDialog: () => null,
  }));
  mock.module("./HerdrSetupCard", () => ({ HerdrSetupCard: () => null }));
  mock.module("./TerminalFileLinkMenu", () => ({
    TerminalFileLinkMenu: () => null,
  }));
  mock.module("./AnnotationComposerPopover", () => ({
    AnnotationComposerPopover: () => null,
  }));
  mock.module("../terminalLinkProvider", () => ({
    registerTerminalLinkProvider: disposable,
  }));
  mock.module("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
  mock.module("@xterm/addon-unicode-graphemes", () => ({
    UnicodeGraphemesAddon: class {},
  }));
  mock.module("@xterm/addon-fit", () => ({
    FitAddon: class {
      fit() {}
      proposeDimensions() {
        return { cols: 80, rows: 24 };
      }
    },
  }));
  const terminals: FakeTerminal[] = [];
  class FakeTerminal {
    private currentOptions: Record<string, unknown> = {};
    get options() {
      return this.currentOptions;
    }
    set options(value: Record<string, unknown>) {
      Object.assign(this.currentOptions, value);
    }
    cols = 80;
    rows = 24;
    buffer = {
      active: { viewportY: 0, baseY: 0, length: 24, getLine: () => undefined },
    };
    modes = { mouseTrackingMode: "none" };
    element!: HTMLDivElement;
    textarea!: HTMLTextAreaElement;
    onDataCallback: (text: string) => void = noop;
    focusCount = 0;
    disposed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminals.push(this);
    }
    open(container: HTMLElement) {
      this.element = document.createElement("div");
      this.element.className = "xterm";
      this.textarea = document.createElement("textarea");
      this.textarea.className = "xterm-helper-textarea";
      this.element.append(this.textarea);
      container.append(this.element);
    }
    focus() {
      this.focusCount++;
      this.textarea.focus();
    }
    blur() {
      this.textarea.blur();
    }
    onData(callback: (text: string) => void) {
      this.onDataCallback = callback;
      return disposable();
    }
    onRender = disposable;
    onSelectionChange = disposable;
    onResize = disposable;
    loadAddon = noop;
    refresh = noop;
    reset = noop;
    clearSelection = noop;
    keyHandler: (event: KeyboardEvent) => boolean = () => true;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    selection = false;
    hasSelection = () => this.selection;
    getSelection = () => "";
    getSelectionPosition = () => undefined;
    writes: string[] = [];
    write(text: string, parsed?: () => void) {
      this.writes.push(text);
      parsed?.();
    }
    dispose() {
      this.disposed = true;
      this.element.remove();
    }
  }
  mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
  const { TerminalView } = await import("./TerminalView");
  const { TERMINAL_INPUT_MODE_STORAGE_KEY } = await import(
    "../terminalInputMode"
  );
  const { roamgateLocalStorage, subscribeLocalStorage } = await import(
    "../browserStorage"
  );
  const { normalizeTerminalFontScale } = await import("../appearance");
  const {
    clearTerminalComposerDraft,
    readTerminalComposerDraft,
    terminalComposerDraftKey,
    writeTerminalComposerDraft,
  } = await import("../terminalComposer");
  const draftKey = terminalComposerDraftKey("connection-a", 1, "pane-a");
  const storageKey = `roamgate:${TERMINAL_INPUT_MODE_STORAGE_KEY}`;
  let root: Root | null = null;
  let container: HTMLDivElement;
  let open = false;
  let strict = false;
  let explicitPane: string | undefined;
  let terminalFontScale = 100;
  let mobileShortcuts: MobileTerminalShortcutRows = [[], []];
  beforeEach(() => {
    state = initialState();
    calls.length = 0;
    terminals.length = 0;
    clients.clear();
    terminalListeners.clear();
    scrollDisabledReason = null;
    scrollReason.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    open = false;
    strict = false;
    explicitPane = undefined;
    terminalFontScale = 100;
    mobileShortcuts = [[], []];
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    clearTerminalComposerDraft(draftKey);
    document.documentElement.classList.remove("keyboard-open");
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    mock.restore();
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function render() {
    const view = createElement(TerminalView, {
      paneId: explicitPane,
      terminalTheme: {},
      terminalFontFamily: "monospace",
      terminalFontScale,
      showMobileKeys: false,
      mobileShortcuts,
      mobileSideShortcuts: [],
      composerOpen: open,
      onComposerOpenChange(next: boolean) {
        open = next;
        render();
      },
    });
    root!.render(strict ? createElement(StrictMode, null, view) : view);
  }
  async function mount(initiallyOpen = false, strictMode = false) {
    open = initiallyOpen;
    strict = strictMode;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => render());
  }
  const currentTerminal = () => terminals[terminals.length - 1]!;
  const selectedMode = () =>
    [
      ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ].find((input) => input.checked)?.value;
  const savedMode = () => localStorage.getItem(storageKey);
  async function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () =>
      element!.dispatchEvent(
        new browser.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
        }) as unknown as MouseEvent,
      ),
    );
  }
  const choose = (mode: TerminalInputMode) => click(`input[value="${mode}"]`);
  async function setOpen(next: boolean) {
    open = next;
    await act(async () => render());
  }
  async function patch(values: Partial<typeof state>) {
    state = { ...state, ...values };
    await act(async () => render());
  }
  function expectInputBlocked(term = currentTerminal()) {
    const before = calls.filter(
      (call) => call.method === "terminal.input",
    ).length;
    expect(term.options.disableStdin).toBe(true);
    expect(term.textarea.readOnly).toBe(true);
    act(() => term.onDataCallback("blocked"));
    expect(
      calls.filter((call) => call.method === "terminal.input"),
    ).toHaveLength(before);
  }
  async function typeGesture() {
    // Match App's Type click: open+commit, then synchronously focus the dock
    // root, whose handler routes Direct focus, all in one gesture.
    await act(async () => {
      flushSync(() => {
        open = true;
        render();
      });
      const target = container.querySelector<HTMLElement>(".terminal-composer");
      expect(target).not.toBeNull();
      target!.focus({ preventScroll: true });
      // Assert during the gesture, before act can flush any later work.
      if (
        selectedMode() === "direct" &&
        state.status === "connected" &&
        !state.connectionPaused
      ) {
        expect(document.activeElement).toBe(currentTerminal().textarea);
        expect(currentTerminal().options.disableStdin).toBe(false);
      }
    });
  }

  test("Ctrl+/ sends one unambiguous slash key and suppresses xterm's Ctrl+_ fallback", async () => {
    await mount(true);
    await choose("direct");
    await frame(false);
    const term = currentTerminal();
    const event = new browser.KeyboardEvent("keydown", {
      key: "/",
      code: "Slash",
      keyCode: 191,
      ctrlKey: true,
      cancelable: true,
    }) as unknown as KeyboardEvent;
    let handled: boolean | undefined;
    await act(async () => {
      handled = term.keyHandler(event);
    });
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    const input = calls.filter((call) => call.method === "terminal.input");
    expect(input).toHaveLength(1);
    expect(atob(String(input[0]!.params.data))).toBe("\x1b[47;5u");
    const up = new browser.KeyboardEvent("keyup", {
      key: "/",
      code: "Slash",
      ctrlKey: true,
    }) as unknown as KeyboardEvent;
    await act(async () => {
      expect(term.keyHandler(up)).toBe(true);
    });
    expect(
      calls.filter((call) => call.method === "terminal.input"),
    ).toHaveLength(1);
    await patch({ connectionPaused: true });
    await act(async () => {
      expect(term.keyHandler(event)).toBe(false);
    });
    expect(
      calls.filter((call) => call.method === "terminal.input"),
    ).toHaveLength(1);
  });

  test("legacy terminals keep xterm's existing raw-key encoding", async () => {
    await mount(true);
    await choose("direct");
    await frame();
    for (const key of ["/", "Backspace", "Enter", "Escape", "["]) {
      const event = new browser.KeyboardEvent("keydown", {
        key,
        ctrlKey: key === "/" || key === "Backspace",
        altKey: !["/", "Backspace", "Enter"].includes(key),
        cancelable: true,
      }) as unknown as KeyboardEvent;
      await act(async () => {
        expect(currentTerminal().keyHandler(event)).toBe(true);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(
      calls.filter((call) => call.method === "terminal.input"),
    ).toHaveLength(0);
  });

  test("a configured terminal action takes precedence over Ctrl+/ forwarding", async () => {
    const {
      getShortcutSnapshot,
      updateShortcut,
      selectShortcutPreset,
      deleteShortcutPreset,
    } = await import("../shortcutPreferences");
    const previous = getShortcutSnapshot().preset.id;
    updateShortcut("terminal.pageUp", ["Ctrl+Slash"]);
    const custom = getShortcutSnapshot().preset.id;
    try {
      await mount(true);
      await choose("direct");
      await frame(false);
      const event = new browser.KeyboardEvent("keydown", {
        key: "/",
        code: "Slash",
        keyCode: 191,
        ctrlKey: true,
        cancelable: true,
      }) as unknown as KeyboardEvent;
      await act(async () => {
        expect(currentTerminal().keyHandler(event)).toBe(false);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(
        calls.filter((call) => call.method === "terminal.input"),
      ).toHaveLength(0);
      expect(
        calls.filter((call) => call.method === "terminal.scroll"),
      ).toHaveLength(1);
    } finally {
      selectShortcutPreset(previous);
      deleteShortcutPreset(custom);
    }
  });

  for (const mode of ["composer", "direct"] as const) {
    for (const endpoint of [false, true]) {
      test(`${mode} shortcut buttons preserve the ${endpoint ? "semantic" : "legacy"} transport`, async () => {
        mobileShortcuts = [
          [
            {
              id: "slash",
              label: "Slash",
              action: { key: "/", ctrl: true, alt: false, shift: false },
            },
            {
              id: "punctuation",
              label: "Punctuation",
              action: { key: ";", ctrl: true, alt: true, shift: false },
            },
          ],
          [],
        ];
        await mount(true);
        await choose(mode);
        await frame(endpoint ? false : undefined);
        // Frame delivery updates the transport before rendering button state.
        await act(async () => render());
        await click('[aria-label="Send Ctrl+/"]');
        const input = calls.filter((call) => call.method === "terminal.input");
        expect(input).toHaveLength(1);
        expect(atob(String(input[0]!.params.data))).toBe(
          endpoint ? "\x1b[47;5u" : "\x1f",
        );
        const punctuation = container.querySelector<HTMLButtonElement>(
          '[aria-label="Send Ctrl+Alt+;"]',
        )!;
        expect(punctuation.disabled).toBe(!endpoint);
        if (endpoint) {
          await click('[aria-label="Send Ctrl+Alt+;"]');
          const last = calls
            .filter((call) => call.method === "terminal.input")
            .slice(-1)[0]!;
          expect(atob(String(last.params.data))).toBe("\x1b[59;7u");
        } else {
          expect(punctuation.title).toContain("requires an endpoint terminal");
        }
      });
    }
  }

  const scrollCalls = () =>
    calls
      .filter((call) => call.method === "terminal.scroll")
      .map((call) => call.params);
  async function frame(mouseReporting?: boolean, text = "terminal output") {
    await act(async () => {
      for (const listener of terminalListeners)
        listener({
          connection_id: state.activeConnectionId,
          connection_generation: 1,
          terminal_id: "terminal-a",
          width: 80,
          height: 24,
          full: true,
          bytes: btoa(text),
          mouse_reporting: mouseReporting,
        });
    });
    // Happy DOM has no layout. Supply the public geometry used for routing.
    currentTerminal().element.getBoundingClientRect = () =>
      new browser.DOMRect(10, 20, 800, 480) as unknown as DOMRect;
  }
  function touch(
    target: HTMLElement,
    type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
    y: number,
    count = type === "touchend" || type === "touchcancel" ? 0 : 1,
  ) {
    const event = new browser.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", {
      value: Array.from({ length: count }, (_, identifier) => ({
        identifier,
        clientX: 50,
        clientY: y,
      })),
    });
    act(() => target.dispatchEvent(event as unknown as Event));
    return event;
  }
  function swipe(
    target: HTMLElement = currentTerminal().element,
    from = 100,
    to = 148,
  ) {
    act(() =>
      target.dispatchEvent(
        new browser.PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
        }) as unknown as PointerEvent,
      ),
    );
    touch(target, "touchstart", from);
    const move = touch(target, "touchmove", to);
    const end = touch(target, "touchend", to);
    return { move, end };
  }

  for (const mode of ["composer", "direct", "closed"] as const) {
    test.each([undefined, false, true])(
      `${mode} terminal touch scroll preserves routing and keyboard state (mouse reporting %s)`,
      async (mouseReporting) => {
        await mount();
        if (mode !== "closed") await typeGesture();
        if (mode === "direct") await choose("direct");
        await frame(mouseReporting);
        const term = currentTerminal();
        term.modes.mouseTrackingMode = mouseReporting ? "drag" : "none";
        const focused = document.activeElement;
        const focusCount = term.focusCount;
        const { move, end } = swipe();
        expect(move.defaultPrevented).toBe(true);
        expect(end.defaultPrevented).toBe(true);
        expect(scrollCalls()).toEqual([
          {
            terminal_id: "terminal-a",
            direction: "up",
            lines: 2,
            source: "wheel",
            column: 4,
            row: 6,
          },
        ]);
        swipe(term.element, 148, 100);
        expect(scrollCalls()[1]).toEqual({
          terminal_id: "terminal-a",
          direction: "down",
          lines: 2,
          source: "wheel",
          column: 4,
          row: 4,
        });
        expect(scrollReason).toHaveBeenLastCalledWith(
          "terminal-a",
          mouseReporting,
        );
        expect(document.activeElement).toBe(focused);
        expect(term.focusCount).toBe(focusCount);
        expect(calls.some((call) => call.method === "terminal.input")).toBe(
          false,
        );
        if (mode === "direct") {
          expect(term.options.disableStdin).toBe(false);
          expect(term.textarea.readOnly).toBe(false);
          act(() => term.onDataCallback("still direct"));
          expect(
            calls.filter((call) => call.method === "terminal.input"),
          ).toHaveLength(1);
        } else expectInputBlocked();
      },
    );
  }

  test.each(["touch", "mouse"])(
    "mobile capsule toggle pointerdown preserves Direct input and draft (%s)",
    async (pointerType) => {
      writeTerminalComposerDraft(draftKey, "unsent Composer draft");
      localStorage.setItem(storageKey, "direct");
      await mount();
      await typeGesture();
      const term = currentTerminal();
      document.documentElement.classList.add("keyboard-open");
      const toggle = document.createElement("button");
      toggle.className = "mobile-controls-toggle";
      const icon = document.createElement("span");
      toggle.append(icon);
      document.body.append(toggle);
      const focusCount = term.focusCount;
      // Dispatch through the real document capture handler. App's mousedown
      // focus guard is tested separately; cancellation there cannot prevent
      // an explicit earlier blur in TerminalView's capture listener.
      act(() =>
        icon.dispatchEvent(
          new browser.PointerEvent("pointerdown", {
            bubbles: true,
            pointerType,
          }) as unknown as PointerEvent,
        ),
      );
      expect(document.activeElement).toBe(term.textarea);
      expect(term.focusCount).toBe(focusCount);
      expect(term.options.disableStdin).toBe(false);
      expect(term.textarea.readOnly).toBe(false);
      expect(selectedMode()).toBe("direct");
      expect(savedMode()).toBe("direct");
      expect(readTerminalComposerDraft(draftKey)).toBe("unsent Composer draft");
      act(() => term.onDataCallback("continue typing"));
      expect(
        calls.filter((call) => call.method === "terminal.input"),
      ).toHaveLength(1);
      // Ordinary outside navigation retains the existing keyboard-dismiss path.
      const outside = document.createElement("button");
      document.body.append(outside);
      act(() =>
        outside.dispatchEvent(
          new browser.PointerEvent("pointerdown", {
            bubbles: true,
            pointerType,
          }) as unknown as PointerEvent,
        ),
      );
      expect(document.activeElement).not.toBe(term.textarea);
    },
  );

  test.each(["touch", "mouse"])(
    "compact capsule row pan does not retire Direct keyboard input (%s)",
    async (pointerType) => {
      localStorage.setItem(storageKey, "direct");
      await mount();
      await typeGesture();
      const term = currentTerminal();
      document.documentElement.classList.add("keyboard-open");
      const app = document.createElement("div");
      app.className = "app";
      app.setAttribute("data-mobile-controls-compact", "");
      const row = document.createElement("div");
      row.className = "mobile-controls-stack";
      const button = document.createElement("button");
      const icon = document.createElement("span");
      button.append(icon);
      row.append(button);
      app.append(row);
      document.body.append(app);
      const down = () =>
        act(() =>
          icon.dispatchEvent(
            new browser.PointerEvent("pointerdown", {
              bubbles: true,
              pointerType,
            }) as unknown as PointerEvent,
          ),
        );
      down();
      touch(row, "touchstart", 100);
      touch(row, "touchmove", 101);
      touch(row, "touchend", 101);
      expect(document.activeElement).toBe(term.textarea);
      expect(term.options.disableStdin).toBe(false);
      expect(term.textarea.readOnly).toBe(false);
      expect(scrollCalls()).toEqual([]);
      expect(calls.some((call) => call.method === "terminal.input")).toBe(
        false,
      );
      // Only the compact pan surface gets this exemption; normal navigation
      // keeps the existing outside-pointer dismissal behavior.
      app.removeAttribute("data-mobile-controls-compact");
      down();
      expect(document.activeElement).not.toBe(term.textarea);
    },
  );

  test("Composer draft gestures remain native while terminal swipes and output preserve editing", async () => {
    await mount();
    await typeGesture();
    await frame(false);
    const editor = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Terminal input draft"]',
    )!;
    await act(async () => {
      document.documentElement.classList.add("keyboard-open");
      editor.focus();
      Object.getOwnPropertyDescriptor(
        browser.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "draft line one\nline two\nline three");
      editor.dispatchEvent(
        new browser.Event("input", { bubbles: true }) as unknown as Event,
      );
    });
    editor.setSelectionRange(2, 5);
    editor.scrollTop = 17;
    act(() =>
      editor.dispatchEvent(
        new browser.CompositionEvent("compositionstart", {
          bubbles: true,
        }) as unknown as CompositionEvent,
      ),
    );
    const { move, end } = swipe(editor);
    expect(move.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(scrollCalls()).toEqual([]);
    swipe();
    const term = currentTerminal();
    const writesBeforeUpdate = term.writes.length;
    // A changed repaint must reach xterm; identical frames are deduplicated.
    await frame(false, "updated terminal output");
    expect(term.writes).toHaveLength(writesBeforeUpdate + 1);
    expect(term.writes[term.writes.length - 1]).toBe("updated terminal output");
    expect(scrollCalls()).toHaveLength(1);
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("draft line one\nline two\nline three");
    expect(readTerminalComposerDraft(draftKey)).toBe(editor.value);
    expect([
      editor.selectionStart,
      editor.selectionEnd,
      editor.scrollTop,
    ]).toEqual([2, 5, 17]);
    expect(currentTerminal().focusCount).toBe(0);
    expectInputBlocked();
    expect(
      container.querySelector<HTMLInputElement>('input[value="direct"]')!
        .disabled,
    ).toBe(true);
    act(() =>
      editor.dispatchEvent(
        new browser.CompositionEvent("compositionend", {
          bubbles: true,
        }) as unknown as CompositionEvent,
      ),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[value="direct"]')!
        .disabled,
    ).toBe(false);
  });

  test.each([false, true])(
    "Composer swipes still respect endpoint selection and scroll availability (%s)",
    async (mouseReporting) => {
      await mount(true);
      await frame(mouseReporting);
      const term = currentTerminal();
      term.selection = true;
      expect(swipe().move.defaultPrevented).toBe(true);
      expect(scrollCalls()).toEqual([]);
      term.selection = false;
      scrollDisabledReason = "Scroll is unavailable";
      swipe();
      expect(scrollCalls()).toEqual([]);
      expect(scrollReason).toHaveBeenLastCalledWith(
        "terminal-a",
        mouseReporting,
      );
      scrollDisabledReason = null;
      swipe();
      expect(scrollCalls()).toHaveLength(1);
      expectInputBlocked();
    },
  );

  test("Composer swipes retain line accumulation, per-move bounds, and cancellation", async () => {
    await mount(true);
    await frame(false);
    const target = currentTerminal().element;
    touch(target, "touchstart", 100);
    touch(target, "touchmove", 108);
    touch(target, "touchmove", 116);
    expect(scrollCalls()).toEqual([]);
    touch(target, "touchmove", 124);
    expect(scrollCalls().map((call) => call.lines)).toEqual([1]);
    touch(target, "touchmove", 132);
    touch(target, "touchcancel", 132);
    touch(target, "touchmove", 100);
    expect(scrollCalls()).toHaveLength(1);
    touch(target, "touchstart", 100);
    touch(target, "touchmove", 116);
    expect(scrollCalls()).toHaveLength(1);
    touch(target, "touchmove", 124, 2);
    expect(scrollCalls()).toHaveLength(1);
    touch(target, "touchcancel", 124);
    swipe(target, 100, 1100);
    expect(scrollCalls()[1]!.lines).toBe(currentTerminal().rows);
    expectInputBlocked();
  });

  test.each(["composer", "direct", "closed"] as const)(
    "%s terminal taps keep their existing focus behavior",
    async (mode) => {
      await mount(mode !== "closed");
      if (mode === "direct") {
        await choose("direct");
        act(() => currentTerminal().textarea.blur());
      }
      await frame(false);
      const term = currentTerminal();
      const before = term.focusCount;
      touch(term.element, "touchstart", 100);
      touch(term.element, "touchend", 100);
      expect(scrollCalls()).toEqual([]);
      expect(term.focusCount).toBe(before + (mode === "direct" ? 1 : 0));
      if (mode === "direct") expect(document.activeElement).toBe(term.textarea);
      else expectInputBlocked();
    },
  );

  test.each([null, "", "DIRECT", "invalid", "composer"])(
    "opening defaults safely to Composer for stored %s",
    async (value) => {
      if (value !== null) localStorage.setItem(storageKey, value);
      await mount();
      await setOpen(true);
      expect(selectedMode()).toBe("composer");
      expect(savedMode()).toBe(value);
      expectInputBlocked();
    },
  );

  test("Type keeps Composer neutral until its native draft is explicitly focused", async () => {
    await mount();
    await typeGesture();
    expect(selectedMode()).toBe("composer");
    expect(document.activeElement).toBe(
      container.querySelector(".terminal-composer"),
    );
    const editor = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Terminal input draft"]',
    )!;
    act(() => editor.focus());
    expect(document.activeElement).toBe(editor);
    act(() => editor.blur());
    const focused = document.activeElement;
    await frame(false);
    swipe();
    await frame(false, "output after keyboard dismissal");
    expect(scrollCalls()).toHaveLength(1);
    expect(document.activeElement).toBe(focused);
    act(() => editor.focus());
    expect(document.activeElement).toBe(editor);
    expect(savedMode()).toBeNull();
    expectInputBlocked();
    expect(currentTerminal().focusCount).toBe(0);
  });

  test("manual mode choices survive close and reopen without opening stdin", async () => {
    await mount();
    await setOpen(true);
    await choose("direct");
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expect(document.activeElement).toBe(currentTerminal().textarea);
    await click('[aria-label="Close terminal input"]');
    expect(container.querySelector(".terminal-composer")).toBeNull();
    expectInputBlocked();
    await setOpen(true);
    expect(selectedMode()).toBe("direct");
    expectInputBlocked();
    await choose("composer");
    expect(savedMode()).toBe("composer");
    await setOpen(false);
    await setOpen(true);
    expect(selectedMode()).toBe("composer");
    expectInputBlocked();
  });

  test("saved Direct restores after unmount and a new closed dock", async () => {
    await mount();
    await setOpen(true);
    await choose("direct");
    await act(async () => root!.unmount());
    root = null;
    await mount();
    await setOpen(true);
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expectInputBlocked();
  });

  test("an initially open dock restores saved Direct without activating input", async () => {
    localStorage.setItem(storageKey, "direct");
    await mount(true);
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expectInputBlocked();
    expect(currentTerminal().focusCount).toBe(0);
  });

  test("StrictMode initially-open dock restores Direct without enabling stdin", async () => {
    localStorage.setItem(storageKey, "direct");
    await mount(true, true);
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expectInputBlocked();
    expect(terminals.every((term) => term.focusCount === 0)).toBe(true);
    await patch({ connectionGeneration: 2 });
    expect(selectedMode()).toBe("composer");
    expect(savedMode()).toBe("direct");
    expectInputBlocked();
    expect(terminals.every((term) => term.focusCount === 0)).toBe(true);
  });

  test("storage-backed Direct restores on first opening after a page reload", async () => {
    // Seed the durable browser key directly, with no remembered module choice.
    localStorage.setItem(storageKey, "direct");
    await mount();
    await typeGesture();
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expect(currentTerminal().options.disableStdin).toBe(false);
    expect(document.activeElement).toBe(currentTerminal().textarea);
  });

  test("Commands temporarily switches to Composer without saving", async () => {
    await mount();
    await setOpen(true);
    await choose("direct");
    await click('[aria-label="Commands"]');
    expect(selectedMode()).toBe("composer");
    expect(savedMode()).toBe("direct");
    expectInputBlocked();
    await setOpen(false);
    await setOpen(true);
    expect(selectedMode()).toBe("direct");
    expectInputBlocked();
  });

  test.each(["direct", "composer", "saved Direct"])(
    "remote font scale updates preserve %s input, focus and draft",
    async (mode) => {
      writeTerminalComposerDraft(draftKey, "unsent draft");
      if (mode === "saved Direct") localStorage.setItem(storageKey, "direct");
      await mount();
      await setOpen(true);
      if (mode !== "saved Direct") await choose(mode as TerminalInputMode);
      const term = currentTerminal();
      const editor = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Terminal input draft"]',
      );
      if (editor) editor.setSelectionRange(3, 8);
      const focused = document.activeElement;
      const focusCount = term.focusCount;
      const expectedMode = selectedMode();
      const preference = savedMode();
      // Model App's subscription so native prefixed events reach a real commit.
      const unsubscribe = subscribeLocalStorage((key) => {
        if (key !== null && key !== "terminalFontScale" && key !== "uiScale")
          return;
        terminalFontScale = normalizeTerminalFontScale(
          roamgateLocalStorage.getItem("terminalFontScale"),
          roamgateLocalStorage.getItem("uiScale"),
        );
        render();
      });
      try {
        for (const scale of [105, 90, 100]) {
          await act(async () => {
            localStorage.setItem("roamgate:terminalFontScale", String(scale));
            window.dispatchEvent(
              new browser.StorageEvent("storage", {
                key: "roamgate:terminalFontScale",
                newValue: String(scale),
                storageArea: browser.localStorage,
              }) as unknown as Event,
            );
          });
          expect(currentTerminal()).toBe(term);
          expect(term.options.fontSize).toBe((12 * scale) / 100);
          expect(selectedMode()).toBe(expectedMode);
          expect(savedMode()).toBe(preference);
          expect(document.activeElement).toBe(focused);
          expect(term.focusCount).toBe(focusCount);
          expect(readTerminalComposerDraft(draftKey)).toBe("unsent draft");
          if (editor) {
            expect(editor.value).toBe("unsent draft");
            expect(editor.selectionStart).toBe(3);
            expect(editor.selectionEnd).toBe(8);
          }
          const before = calls.filter(
            (call) => call.method === "terminal.input",
          );
          if (mode === "direct") {
            expect(term.options.disableStdin).toBe(false);
            expect(term.textarea.readOnly).toBe(false);
            act(() => term.onDataCallback("continued"));
            const input = calls.filter(
              (call) => call.method === "terminal.input",
            );
            expect(input).toHaveLength(before.length + 1);
            expect(input[input.length - 1]?.params.terminal_id).toBe(
              "terminal-a",
            );
          } else expectInputBlocked();
        }
      } finally {
        unsubscribe();
      }
    },
  );

  test.each([
    "status",
    "paused",
    "pane",
    "connection",
    "generation",
    "attach epoch",
    "inactive split",
  ])(
    "%s safety reset preserves saved Direct and blocks stale input",
    async (change) => {
      if (change === "inactive split") explicitPane = "pane-a";
      await mount();
      await setOpen(true);
      await choose("direct");
      terminalFontScale = 105;
      await act(async () => render());
      expect(selectedMode()).toBe("direct");
      const previousTerminal = currentTerminal();
      const previousFocusCount = previousTerminal.focusCount;
      if (change === "status") await patch({ status: "disconnected" });
      if (change === "paused") await patch({ connectionPaused: true });
      if (change === "pane") await patch({ selectedPaneId: "pane-b" });
      if (change === "inactive split")
        await patch({ selectedPaneId: "pane-b" });
      if (change === "connection")
        await patch({
          activeConnectionId: "connection-b",
          connections: [{ id: "connection-b", generation: 1 }],
        });
      if (change === "generation") await patch({ connectionGeneration: 2 });
      if (change === "attach epoch") await patch({ terminalAttachEpoch: 1 });
      expect(selectedMode()).toBe("composer");
      expect(savedMode()).toBe("direct");
      expectInputBlocked();
      expect(currentTerminal().focusCount).toBe(
        currentTerminal() === previousTerminal ? previousFocusCount : 0,
      );
      expect(document.activeElement).not.toBe(currentTerminal().textarea);
      const before = calls.filter(
        (call) => call.method === "terminal.input",
      ).length;
      act(() => previousTerminal.onDataCallback("stale"));
      expect(
        calls.filter((call) => call.method === "terminal.input"),
      ).toHaveLength(before);
    },
  );

  test("reconnect does not reopen Direct until another explicit Type gesture", async () => {
    await mount();
    await setOpen(true);
    await choose("direct");
    await patch({ status: "disconnected" });
    await patch({ status: "connected" });
    expect(selectedMode()).toBe("composer");
    expectInputBlocked();
    expect(currentTerminal().focusCount).toBe(1);
    expect(savedMode()).toBe("direct");
    await setOpen(false);
    await typeGesture();
    expect(selectedMode()).toBe("direct");
    expect(currentTerminal().options.disableStdin).toBe(false);
    expect(currentTerminal().textarea.readOnly).toBe(false);
    act(() => currentTerminal().onDataCallback("new-session"));
    expect(
      calls.filter((call) => call.method === "terminal.input").slice(-1)[0]
        ?.params.terminal_id,
    ).toBe("terminal-a");
  });

  test("Type uses current pane and connection refs after a safe reset", async () => {
    roamgateLocalStorage.setItem(TERMINAL_INPUT_MODE_STORAGE_KEY, "direct");
    await mount();
    await patch({
      selectedPaneId: "pane-b",
      activeConnectionId: "connection-b",
      connections: [{ id: "connection-b", generation: 2 }],
      connectionGeneration: 2,
    });
    await typeGesture();
    expect(selectedMode()).toBe("direct");
    expect(currentTerminal().options.disableStdin).toBe(false);
    expect(document.activeElement).toBe(currentTerminal().textarea);
    act(() => currentTerminal().onDataCallback("current"));
    expect(
      calls.filter((call) => call.method === "terminal.input").slice(-1)[0]
        ?.params.terminal_id,
    ).toBe("terminal-b");
  });

  test("opening while disconnected stays safe and retains the preference", async () => {
    localStorage.setItem(storageKey, "direct");
    await mount();
    await patch({ status: "disconnected" });
    await typeGesture();
    expect(selectedMode()).toBe("composer");
    expect(savedMode()).toBe("direct");
    expectInputBlocked();
    await patch({ status: "connected" });
    expect(selectedMode()).toBe("composer");
    expectInputBlocked();
  });
}
