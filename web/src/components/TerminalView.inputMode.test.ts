import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { TerminalPush } from "../api";
import type { TerminalInputMode } from "../terminalInputMode";

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
    attachCustomKeyEventHandler = noop;
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
  const { roamgateLocalStorage } = await import("../browserStorage");
  const {
    clearTerminalComposerDraft,
    readTerminalComposerDraft,
    terminalComposerDraftKey,
  } = await import("../terminalComposer");
  const draftKey = terminalComposerDraftKey("connection-a", 1, "pane-a");
  const storageKey = `roamgate:${TERMINAL_INPUT_MODE_STORAGE_KEY}`;
  let root: Root | null = null;
  let container: HTMLDivElement;
  let open = false;
  let strict = false;
  let explicitPane: string | undefined;
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
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    clearTerminalComposerDraft(draftKey);
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
      terminalFontScale: 1,
      showMobileKeys: false,
      mobileShortcuts: [[], []],
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
    // Match MobileSheetHandle's Type click: open+commit, then synchronously focus
    // the dock root, whose handler routes focus, all in one gesture.
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

  test("Composer draft gestures remain native while terminal swipes and output preserve editing", async () => {
    await mount();
    await typeGesture();
    await frame(false);
    const editor = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Terminal input draft"]',
    )!;
    await act(async () => {
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

  test("Type focuses the native draft immediately for default Composer", async () => {
    await mount();
    await typeGesture();
    expect(selectedMode()).toBe("composer");
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Terminal input draft"]'),
    );
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
