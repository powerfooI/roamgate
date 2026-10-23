import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
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
    HTMLInputElement: browser.HTMLInputElement,
    NodeFilter: browser.NodeFilter,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
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
  // Event-driven session history: happy-dom does not model traversal reliably.
  const entries: { state: object | null; url: string }[] = [
    { state: null, url: "/" },
  ];
  let historyIndex = 0;
  const traversals: (() => void)[] = [];
  const replaceLocation = browser.history.replaceState.bind(browser.history);
  Object.defineProperty(browser, "history", {
    value: {
      get state() {
        return entries[historyIndex]!.state;
      },
      pushState(state: object | null, _unused: string, url?: string) {
        entries.splice(historyIndex + 1);
        entries.push({ state, url: url ?? entries[historyIndex]!.url });
        historyIndex++;
        replaceLocation(state, "", entries[historyIndex]!.url);
      },
      replaceState(state: object | null, _unused: string, url?: string) {
        entries[historyIndex] = {
          state,
          url: url ?? entries[historyIndex]!.url,
        };
        replaceLocation(state, "", entries[historyIndex]!.url);
      },
      back() {
        traversals.push(() => {
          if (historyIndex === 0) return;
          const entry = entries[--historyIndex]!;
          replaceLocation(entry.state, "", entry.url);
          browser.dispatchEvent(
            new browser.PopStateEvent("popstate", { state: entry.state }),
          );
        });
      },
    },
  });
  async function settleHistory() {
    for (let turn = 0; turn < 8; turn++) {
      await act(async () => {
        await Promise.resolve();
        for (const complete of traversals.splice(0)) complete();
      });
      if (!traversals.length) return;
    }
    throw new Error("history traversal loop");
  }
  let mobileLayout = true;
  const noop = () => {};
  const disposable = () => ({ dispose: noop });
  type Pane = {
    pane_id: string;
    terminal_id: string;
    workspace_id: string;
    tab_id: string;
    agent?: string;
    agent_status?: string;
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
    tabs: [],
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
  const uploads: {
    resolve: (path: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  const notices: { detail?: string; message: string }[] = [];
  let failPathInput = false;
  let integrationResult: Promise<unknown> = Promise.resolve({
    integrations: [],
  });
  const upload = () =>
    new Promise<string>((resolve, reject) => uploads.push({ resolve, reject }));
  mock.module("../terminalImageUpload", () => ({
    uploadTerminalImage: upload,
    uploadTerminalFile: upload,
  }));
  let scrollDisabledReason: string | null = null;
  const scrollReason = mock(() => scrollDisabledReason);
  mock.module("../store", () => ({
    store: {
      get: () => state,
      subscribe: () => noop,
      terminalScrollReason: scrollReason,
      setTerminalEndpoint: noop,
      notify: (notice: { detail?: string; message: string }) =>
        notices.push(notice),
      clearNotice: noop,
    },
    useStoreSelector: (selector: (value: typeof state) => unknown) =>
      selector(state),
    shallowEqual: Object.is,
    terminalNavigationLoading: () => false,
    useEndpointCreationReason: () => null,
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
              if (method === "integration.list") return integrationResult;
              if (method === "pane.get")
                return {
                  pane: state.panes.find(
                    (pane) => pane.pane_id === params.pane_id,
                  ),
                };
              if (method === "pane.send_input" && failPathInput)
                throw new Error("uncertain write");
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
    isMobileLayout: () => mobileLayout,
    useLayoutPreferences: () => ({ mobile: mobileLayout }),
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
  const { MobileBottomBar } = await import("./MobileBottomBar");
  const { useSystemBack } = await import("../systemBack");
  const { TERMINAL_INPUT_MODE_STORAGE_KEY } = await import(
    "../terminalInputMode"
  );
  const { roamgateLocalStorage, subscribeLocalStorage } = await import(
    "../browserStorage"
  );
  const { normalizeTerminalFontScale } = await import("../appearance");
  const { activeTerminalInput } = await import("../activeTerminalInput");
  const {
    clearTerminalComposerDraft,
    readTerminalComposerDraft,
    terminalComposerDraftKey,
    writeTerminalComposerDraft,
  } = await import("../terminalComposer");
  const draftKey = terminalComposerDraftKey(
    "connection-a",
    1,
    "pane-a",
    "terminal-a",
  );
  const storageKey = `roamgate:${TERMINAL_INPUT_MODE_STORAGE_KEY}`;
  let root: Root | null = null;
  let container: HTMLDivElement;
  let open = false;
  let visible = true;
  let filesOpen = false;
  let tabsOpen = false;
  let moreOpen = false;
  let inputTarget: HTMLDivElement | null = null;
  let viewKey = "initial";
  let strict = false;
  let explicitPane: string | undefined;
  let terminalFontScale = 100;
  let mobileShortcuts: MobileTerminalShortcutRows = [[], []];
  let showMobileKeys = false;
  beforeEach(() => {
    state = initialState();
    calls.length = 0;
    terminals.length = 0;
    clients.clear();
    uploads.length = 0;
    notices.length = 0;
    failPathInput = false;
    integrationResult = Promise.resolve({ integrations: [] });
    terminalListeners.clear();
    scrollDisabledReason = null;
    scrollReason.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    open = false;
    visible = true;
    mobileLayout = true;
    filesOpen = false;
    tabsOpen = false;
    moreOpen = false;
    inputTarget = null;
    strict = false;
    viewKey = "initial";
    explicitPane = undefined;
    terminalFontScale = 100;
    mobileShortcuts = [[], []];
    showMobileKeys = false;
  });
  afterEach(async () => {
    document.documentElement.classList.remove("keyboard-open");
    if (root) await act(async () => root?.unmount());
    await settleHistory();
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
  // Model App's mobile panels around the real TerminalView, which stays
  // mounted when CSS hides the terminal surface behind Files.
  function MobilePanels({
    children,
  }: {
    children?: import("react").ReactNode;
  }) {
    useSystemBack(
      tabsOpen,
      () => {
        tabsOpen = false;
        render();
      },
      "popup",
    );
    useSystemBack(
      moreOpen,
      () => {
        moreOpen = false;
        render();
      },
      "popup",
    );
    useSystemBack(
      filesOpen,
      () => {
        filesOpen = false;
        visible = true;
        render();
      },
      "panel",
    );
    return children;
  }
  function setInputTarget(element: HTMLDivElement | null) {
    inputTarget = element;
    if (element) render();
  }
  function render() {
    const view = createElement(TerminalView, {
      key: viewKey,
      paneId: explicitPane,
      terminalTheme: {},
      terminalFontFamily: "monospace",
      terminalFontScale,
      showMobileKeys,
      mobileShortcuts,
      mobileSideShortcuts: showMobileKeys ? mobileShortcuts[0] : [],
      visible,
      mobileInputTarget: inputTarget,
      onActivateTerminalSurface() {
        visible = true;
        filesOpen = false;
        render();
      },
      composerOpen: open,
      onComposerOpenChange(next: boolean) {
        open = next;
        render();
      },
    });
    // App replaces its mobile single-pane branch with a desktop split tree.
    const layout = mobileLayout
      ? view
      : createElement(
          "div",
          { key: "split" },
          view,
          createElement(TerminalView, {
            paneId: "pane-b",
            terminalTheme: {},
            terminalFontFamily: "monospace",
            terminalFontScale,
            showMobileKeys: false,
            mobileShortcuts,
            mobileSideShortcuts: [],
            composerOpen: false,
          }),
        );
    const bar = createElement(MobileBottomBar, {
      inputRef: setInputTarget,
      tabCount: state.panes.length ? 1 : 0,
      attention: true,
      tabsOpen,
      moreOpen,
      onTabsOpenChange: (next: boolean) => {
        tabsOpen = next;
        render();
      },
      onMoreOpenChange: (next: boolean) => {
        moreOpen = next;
        render();
      },
    });
    const panels = createElement(MobilePanels, null, layout, bar);
    root!.render(strict ? createElement(StrictMode, null, panels) : panels);
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
    container.querySelector<HTMLElement>(".terminal-composer")?.dataset
      .inputMode;
  const savedMode = () => localStorage.getItem(storageKey);
  async function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => {
      if (element?.tagName === "TEXTAREA") element.focus();
      element!.dispatchEvent(
        new browser.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
        }) as unknown as MouseEvent,
      );
    });
  }
  const choose = (mode: TerminalInputMode) =>
    click(
      mode === "composer"
        ? ".terminal-composer-input"
        : ".terminal-mobile-direct",
    );
  async function setOpen(next: boolean) {
    open = next;
    await act(async () => render());
  }
  async function patch(values: Partial<typeof state>) {
    state = { ...state, ...values };
    await act(async () => render());
  }
  async function setLauncherPane(agent?: string, workspaceId = "workspace-a") {
    const update = <T extends Pane>(pane: T): T =>
      pane.pane_id === "pane-a"
        ? { ...pane, agent, agent_status: "unknown", workspace_id: workspaceId }
        : pane;
    state = {
      ...state,
      panes: state.panes.map(update),
      layout: { ...state.layout, panes: state.layout.panes.map(update) },
    };
    if (root) await act(async () => render());
  }

  test.each([undefined, "", "   ", "claude", "pi", "pad", "future-agent"])(
    "launcher is shell-only with agent=%s, regardless of unknown status",
    async (agent) => {
      await setLauncherPane(agent);
      await mount(true);
      expect(!!container.querySelector(".agent-launcher-trigger")).toBe(
        !agent?.trim(),
      );
      await setLauncherPane(agent, "");
      expect(container.querySelector(".agent-launcher-trigger")).toBeNull();
    },
  );

  test("shell-to-agent updates unmount an open launcher and ignore late detection without replacing the editor", async () => {
    let finishDetection!: (value: unknown) => void;
    integrationResult = new Promise((resolve) => {
      finishDetection = resolve;
    });
    await setLauncherPane();
    await mount(true);
    await choose("composer");
    await act(async () => writeTerminalComposerDraft(draftKey, "keep draft"));
    const editor = container.querySelector<HTMLTextAreaElement>(
      "textarea.terminal-composer-input",
    )!;
    editor.setSelectionRange(1, 4);
    await click(".agent-launcher-trigger");
    expect(document.querySelector(".agent-launcher-panel")).not.toBeNull();
    expect(
      calls.filter((call) => call.method === "integration.list"),
    ).toHaveLength(1);
    await setLauncherPane("pad");
    expect(container.querySelector(".agent-launcher-trigger")).toBeNull();
    expect(document.querySelector(".agent-launcher-panel")).toBeNull();
    expect(container.querySelector("textarea.terminal-composer-input")).toBe(
      editor,
    );
    expect(editor.value).toBe("keep draft");
    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(4);
    await act(async () => finishDetection({ integrations: [] }));
    expect(document.querySelector(".agent-launcher-panel")).toBeNull();
    expect(
      calls.some((call) =>
        ["tab.create", "pane.send_input"].includes(call.method),
      ),
    ).toBe(false);
  });

  test.each(["composer", "direct", "existing-draft", "send-failure"])(
    "agent selection sends once with Enter from %s and retains unsent text",
    async (initial) => {
      integrationResult = Promise.resolve({
        integrations: [
          {
            target: "pi",
            label: "Pi",
            command: "pi",
            available: true,
            state: "current",
          },
        ],
      });
      await setLauncherPane();
      await mount(true);
      await choose(initial === "direct" ? "direct" : "composer");
      const draft =
        initial === "existing-draft" ? "keep my draft\nwith another line" : "";
      await act(async () => writeTerminalComposerDraft(draftKey, draft));
      const editor = container.querySelector<HTMLTextAreaElement>(
        "textarea.terminal-composer-input",
      )!;
      editor.setSelectionRange(1, 5);
      const before = calls.length;
      failPathInput = initial === "send-failure";
      await click(".agent-launcher-trigger");
      const pi = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Pi"]',
      )!;
      expect(pi).not.toBeNull();
      await act(async () => {
        pi.click();
        pi.click();
      });
      expect(calls.slice(before).map((call) => call.method)).toEqual([
        "integration.list",
        ...(draft ? [] : ["pane.send_input"]),
      ]);
      if (!draft)
        expect(calls[calls.length - 1]?.params).toEqual({
          pane_id: "pane-a",
          text: "pi",
          keys: ["enter"],
        });
      expect(state.selectedPaneId).toBe("pane-a");
      expect(state.layout.tab_id).toBe("tab-a");
      expect(container.querySelector("textarea.terminal-composer-input")).toBe(
        editor,
      );
      const expected = draft || (failPathInput ? "pi" : "");
      expect(editor.value).toBe(expected);
      expect(readTerminalComposerDraft(draftKey)).toBe(expected);
      if (draft) {
        expect(editor.selectionStart).toBe(1);
        expect(editor.selectionEnd).toBe(5);
      }
      expect(document.activeElement).not.toBe(editor);
      expect(
        container
          .querySelector(".terminal-composer")
          ?.getAttribute("data-input-mode"),
      ).toBe("composer");
      if (draft)
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Clear Message",
        );
      else {
        expect(document.querySelector(".agent-launcher-panel")).toBeNull();
        expect(notices.map((notice) => notice.detail)).toEqual(
          failPathInput ? ["uncertain write"] : [],
        );
      }
    },
  );

  test("desktop open shell composer never mounts the mobile launcher", async () => {
    mobileLayout = false;
    await setLauncherPane();
    await mount(true);
    expect(container.querySelector(".terminal-composer")).not.toBeNull();
    expect(container.querySelector(".agent-launcher-trigger")).toBeNull();
    expect(calls.some((call) => call.method === "integration.list")).toBe(
      false,
    );
  });

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
    // Match a tap that opens the dock: open+commit, then synchronously focus
    // the dock root, whose handler routes Direct focus, and in Composer the
    // draft, all in one gesture.
    await act(async () => {
      flushSync(() => {
        open = true;
        render();
      });
      const target = container.querySelector<HTMLElement>(".terminal-composer");
      expect(target).not.toBeNull();
      target!.focus({ preventScroll: true });
      if (target!.dataset.inputMode === "composer")
        target!
          .querySelector<HTMLElement>(".terminal-composer-input")
          ?.focus({ preventScroll: true });
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

  async function back() {
    browser.history.back();
    await settleHistory();
  }

  test.each([false, true])(
    "only a visible mounted Composer consumes Back (visible %s)",
    async (surfaceVisible) => {
      browser.history.pushState(null, "", "/previous");
      browser.history.pushState(null, "", "/terminal");
      visible = surfaceVisible;
      await mount(true);
      const term = currentTerminal();
      expect(container.querySelector(".terminal-composer")).not.toBeNull();
      await back();
      expect(open).toBe(!surfaceVisible);
      expect(browser.location.pathname).toBe(
        surfaceVisible ? "/terminal" : "/previous",
      );
      expect(currentTerminal()).toBe(term);
    },
  );

  test("multi-pane mobile to desktop replacement removes the Composer guard", async () => {
    browser.history.pushState(null, "", "/previous");
    browser.history.pushState(null, "", "/terminal");
    await mount(true, true);
    const mobileTerminal = currentTerminal();
    await act(async () => {
      mobileLayout = false;
      render();
    });
    await settleHistory();
    expect(currentTerminal()).not.toBe(mobileTerminal);
    expect(browser.history.state).not.toHaveProperty("roamgateBack");
    expect(open).toBe(true);
    await back();
    expect(browser.location.pathname).toBe("/previous");
    expect(open).toBe(true);
  });

  test.each([false, true])(
    "Type, Files, Tabs, Back, Back restores Composer (hidden pane remount %s)",
    async (remount) => {
      browser.history.pushState(null, "", "/terminal");
      writeTerminalComposerDraft(draftKey, "unsent draft");
      await mount();
      await typeGesture();
      let term = currentTerminal();
      await act(async () => {
        visible = false;
        filesOpen = true;
        render();
      });
      if (remount) {
        // A tab/pane replacement while Files covers the terminal must not
        // re-register its still-open, but invisible Composer above Files.
        await act(async () => {
          viewKey = "replacement";
          render();
        });
        expect(currentTerminal()).not.toBe(term);
        term = currentTerminal();
      }
      await act(async () => {
        tabsOpen = true;
        render();
      });
      await back();
      expect(tabsOpen).toBe(false);
      expect(filesOpen).toBe(true);
      expect(open).toBe(true);
      await back();
      expect(filesOpen).toBe(false);
      expect(visible).toBe(true);
      expect(open).toBe(true);
      expect(currentTerminal()).toBe(term);
      expect(
        container.querySelector<HTMLTextAreaElement>(
          '[aria-label="Terminal input draft"]',
        )!.value,
      ).toBe("unsent draft");
      expect(readTerminalComposerDraft(draftKey)).toBe("unsent draft");
      expect(selectedMode()).toBe("composer");
      expectInputBlocked();
      await back();
      expect(open).toBe(false);
    },
  );

  test.each(["closed", "direct", "composer"] as const)(
    "terminal focus activates %s input after touch on a coarse-pointer desktop",
    async (mode) => {
      await mount(mode !== "closed");
      container.className = "workspace-terminal-surface";
      if (mode === "direct") await choose("direct");
      const term = currentTerminal();
      const otherControl = document.createElement("button");
      document.body.append(otherControl);
      act(() => {
        otherControl.dispatchEvent(
          new browser.PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "touch",
          }) as unknown as PointerEvent,
        );
        otherControl.focus();
      });
      expectInputBlocked();
      act(() => term.textarea.focus());
      expect(document.activeElement === term.textarea).toBe(false);
      expectInputBlocked();
      act(() => activeTerminalInput(document)?.focus({ preventScroll: true }));
      if (mode === "composer") {
        expect(document.activeElement).toBe(
          container.querySelector(".terminal-composer-input"),
        );
        expectInputBlocked();
      } else {
        expect(document.activeElement === term.textarea).toBe(true);
        expect(term.options.disableStdin).toBe(false);
        expect(term.textarea.readOnly).toBe(false);
        act(() => term.onDataCallback("focused"));
        expect(
          calls.filter((call) => call.method === "terminal.input"),
        ).toHaveLength(1);
      }
    },
  );

  test.each(["disconnected", "paused", "inactive split"] as const)(
    "terminal focus does not activate input when %s",
    async (change) => {
      explicitPane = "pane-a";
      await mount();
      container.className = "workspace-terminal-surface";
      if (change === "disconnected") await patch({ status: "disconnected" });
      if (change === "paused") await patch({ connectionPaused: true });
      if (change === "inactive split")
        await patch({ selectedPaneId: "pane-b" });
      const term = currentTerminal();
      act(() => activeTerminalInput(document)?.focus({ preventScroll: true }));
      expect(document.activeElement).not.toBe(term.textarea);
      expectInputBlocked();
    },
  );

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
  test("streaming output preserves selections in every Inspector tab", async () => {
    const matchMedia = browser.matchMedia;
    browser.matchMedia = ((query: string) => ({
      ...matchMedia.call(browser, query),
      matches: false,
    })) as typeof browser.matchMedia;
    mobileLayout = false;
    let selection: Selection | null = null;
    const getSelection = spyOn(document, "getSelection").mockImplementation(
      () => selection,
    );
    const flushOutput = async () => {
      await frame(false);
      await act(async () => browser.happyDOM.whenAsyncComplete());
    };
    try {
      await mount();
      await flushOutput();
      const term = terminals[0]!;
      expect(term.focusCount).toBeGreaterThan(0);
      for (const tab of ["files", "changes", "commits", "history"]) {
        const inspector = document.createElement("section");
        inspector.className = "workspace-inspector";
        const content = document.createElement("div");
        content.className = `inspector-${tab}-resource`;
        inspector.append(content);
        document.body.append(inspector);
        const text = document.createTextNode(`Selected ${tab} text`);
        if (tab === "changes" || tab === "commits") {
          const code = document.createElement("span");
          code.append(text);
          content.attachShadow({ mode: "open" }).append(code);
        } else {
          content.append(text);
        }
        selection = {
          isCollapsed: false,
          anchorNode: text,
          focusNode: text,
        } as unknown as Selection;
        term.textarea.blur();
        const before = term.focusCount;
        await flushOutput();
        expect(term.focusCount).toBe(before);
        expect(document.activeElement).not.toBe(term.textarea);
        selection = null;
        await flushOutput();
        expect(term.focusCount).toBeGreaterThan(before);
        inspector.remove();
      }
    } finally {
      getSelection.mockRestore();
      browser.matchMedia = matchMedia;
    }
  });

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
      `${mode} terminal touch scroll preserves routing; external composer touch ends editing (mouse reporting %s)`,
      async (mouseReporting) => {
        await mount();
        if (mode !== "closed") await typeGesture();
        if (mode === "direct") await choose("direct");
        // Type's tap raised the keyboard in Composer's draft; App marks it.
        if (mode === "composer")
          document.documentElement.classList.add("keyboard-open");
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
        // External terminal pointerdown now explicitly retires Message focus,
        // even though xterm prevents native focus transfer during touch scroll.
        // Direct and closed routing/focus must remain unchanged.
        expect(document.activeElement === focused).toBe(mode !== "composer");
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

  test("Composer draft gestures stay native; terminal swipes end focus without losing draft or caret", async () => {
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
    expect(document.activeElement === editor).toBe(true);
    swipe();
    const term = currentTerminal();
    const writesBeforeUpdate = term.writes.length;
    // A changed repaint must reach xterm; identical frames are deduplicated.
    await frame(false, "updated terminal output");
    expect(term.writes).toHaveLength(writesBeforeUpdate + 1);
    expect(term.writes[term.writes.length - 1]).toBe("updated terminal output");
    expect(scrollCalls()).toHaveLength(1);
    expect(document.activeElement === editor).toBe(false);
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
      container.querySelector<HTMLButtonElement>(".terminal-mobile-direct")!
        .disabled,
    ).toBe(true);
    jest.useFakeTimers();
    try {
      act(() =>
        editor.dispatchEvent(
          new browser.CompositionEvent("compositionend", {
            bubbles: true,
          }) as unknown as CompositionEvent,
        ),
      );
      expect(
        container.querySelector<HTMLButtonElement>(".terminal-mobile-direct")!
          .disabled,
      ).toBe(true);
      act(() => jest.advanceTimersByTime(0));
      expect(
        container.querySelector<HTMLButtonElement>(".terminal-mobile-direct")!
          .disabled,
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
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

  test("Type focuses Composer's draft in one tap, and later work stays neutral", async () => {
    await mount();
    await typeGesture();
    expect(selectedMode()).toBe("composer");
    const editor = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Terminal input draft"]',
    )!;
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

  test("Message is the single inline editor with ordered tools and an independent Direct button", async () => {
    mobileShortcuts = [
      [
        {
          id: "test-enter",
          label: "Enter",
          action: { key: "Enter", ctrl: false, alt: false, shift: false },
        },
      ],
      [],
    ];
    await mount();
    const editor = container.querySelector<HTMLTextAreaElement>(
      ".terminal-composer-input",
    )!;
    expect(editor.placeholder).toBe("Message claude…");
    expect(editor.closest(".mobile-bottom-bar")).not.toBeNull();
    expect(
      container.querySelector(".terminal-shell .terminal-composer"),
    ).toBeNull();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(container.querySelectorAll(".terminal-composer-input")).toHaveLength(
      1,
    );
    await click(".terminal-mobile-message");
    expect(selectedMode()).toBe("composer");
    expect(savedMode()).toBe("composer");
    expect(document.activeElement).toBe(editor);
    const tools = [
      ...container.querySelectorAll(".terminal-composer-toolbar > button"),
    ].slice(0, 3);
    expect(tools.map((button) => button.className)).toEqual([
      "terminal-composer-attach",
      "terminal-composer-shortcuts-toggle",
      "terminal-composer-commands-toggle",
    ]);
    expectInputBlocked();
    await click('[aria-label="Close terminal input"]');
    await act(async () => writeTerminalComposerDraft(draftKey, "draft"));
    expect(container.querySelector(".terminal-composer-input")).toBe(editor);
    expect(editor.value).toBe("draft");
    await click(".terminal-mobile-direct");
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expect(document.activeElement).toBe(currentTerminal().textarea);
  });

  test.each([false, true])(
    "secondary surfaces preserve the %s toolbar intent, draft/caret and native focus",
    async (initiallyOpen) => {
      mobileShortcuts = [
        [
          {
            id: "surface-escape",
            label: "Esc",
            action: { key: "Escape", ctrl: false, alt: false, shift: false },
          },
        ],
        [],
      ];
      await mount(initiallyOpen);
      await act(async () =>
        writeTerminalComposerDraft(draftKey, "keep\nthis draft"),
      );
      const editor = container.querySelector<HTMLTextAreaElement>(
        "textarea.terminal-composer-input",
      )!;
      editor.setSelectionRange(2, 7);
      const toolbar = container.querySelector<HTMLElement>(
        ".terminal-composer-toolbar",
      )!;
      const shortcuts = container.querySelector<HTMLElement>(
        ".terminal-composer-shortcuts",
      )!;
      const shortcutsWereHidden = shortcuts.hidden;
      const neutral = document.createElement("button");
      document.body.append(neutral);
      act(() => neutral.focus());
      const focusCount = currentTerminal().focusCount;
      await act(async () => {
        visible = false;
        filesOpen = true;
        render();
      });
      expect(toolbar.hidden).toBe(true);
      expect(shortcuts.hidden).toBe(true);
      expect(container.querySelector(".terminal-composer-commands")).toBeNull();
      expect(
        container.querySelector(".terminal-composer[data-expanded]"),
      ).toBeNull();
      expect(container.querySelector(".terminal-mobile-keys")).toBeNull();
      expect(
        container.querySelector(".terminal-mobile-side-shortcuts"),
      ).toBeNull();
      expect(container.querySelector(".terminal-mobile-message")).toBe(editor);
      expect(
        container.querySelectorAll(".terminal-mobile-input-bar"),
      ).toHaveLength(1);
      expect(container.querySelector(".terminal-mobile-direct")).not.toBeNull();
      expect(container.querySelector(".mobile-appbar-tabs")).not.toBeNull();
      expect(container.querySelector(".mobile-appbar-more")).not.toBeNull();
      expect(document.activeElement).toBe(neutral);
      // Neither popup overrides the underlying secondary-surface presentation.
      await click(".mobile-appbar-more");
      expect(toolbar.hidden).toBe(true);
      await click(".mobile-appbar-tabs");
      expect(toolbar.hidden).toBe(true);
      await back();
      expect(filesOpen).toBe(true);
      expect(open).toBe(initiallyOpen);
      await back();
      expect(filesOpen).toBe(false);
      expect(open).toBe(initiallyOpen); // Back closes the page, not its background dock.
      expect(toolbar.hidden).toBe(!initiallyOpen);
      expect(shortcuts.hidden).toBe(shortcutsWereHidden);
      expect(editor.value).toBe("keep\nthis draft");
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 7]);
      expect(readTerminalComposerDraft(draftKey)).toBe(editor.value);
      expect(currentTerminal().focusCount).toBe(focusCount);
      expect(document.activeElement).not.toBe(editor);
      expectInputBlocked();
      // More/Tabs in the terminal must NOT hide accessories.
      for (const entry of [".mobile-appbar-more", ".mobile-appbar-tabs"]) {
        await click(entry);
        expect(toolbar.hidden).toBe(!initiallyOpen);
        await back();
      }
    },
  );

  test("secondary presentation preserves hidden shortcuts and commands without exposing stale combobox ARIA", async () => {
    mobileShortcuts = [
      [
        {
          id: "surface-tab",
          label: "Tab",
          action: { key: "Tab", ctrl: false, alt: false, shift: false },
        },
      ],
      [],
    ];
    await mount(true);
    const toolbar = container.querySelector<HTMLElement>(
      ".terminal-composer-toolbar",
    )!;
    const shortcuts = container.querySelector<HTMLElement>(
      ".terminal-composer-shortcuts",
    )!;
    const editor = container.querySelector<HTMLTextAreaElement>(
      ".terminal-composer-input",
    )!;
    // Explicitly turn shortcuts off; presentation must not overwrite that choice.
    if (!shortcuts.hidden) await click(".terminal-composer-shortcuts-toggle");
    await click(".terminal-composer-commands-toggle");
    expect(editor.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector(".terminal-composer-commands"),
    ).not.toBeNull();
    await act(async () => {
      visible = false;
      filesOpen = true;
      render();
    });
    expect(toolbar.hidden).toBe(true);
    expect(shortcuts.hidden).toBe(true);
    expect(editor.getAttribute("aria-expanded")).toBe("false");
    expect(editor.hasAttribute("aria-controls")).toBe(false);
    expect(editor.hasAttribute("aria-activedescendant")).toBe(false);
    expect(container.querySelector(".terminal-composer-commands")).toBeNull();
    const draftBeforeKeys = editor.value;
    for (const key of ["ArrowDown", "Tab", "Escape"]) {
      const event = new browser.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      await act(async () =>
        editor.dispatchEvent(event as unknown as KeyboardEvent),
      );
      expect(event.defaultPrevented).toBe(false);
      expect(editor.value).toBe(draftBeforeKeys);
    }
    const focused = document.activeElement;
    await back();
    expect(document.activeElement).toBe(focused);
    expect(editor.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector(".terminal-composer-commands"),
    ).not.toBeNull();
    await click('[aria-label="Dismiss commands"]');
    expect(shortcuts.hidden).toBe(true);
    expect(
      container
        .querySelector(".terminal-composer-shortcuts-toggle")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expectInputBlocked();
  });

  test("legacy floating shortcut controls never leak onto secondary surfaces", async () => {
    showMobileKeys = true;
    mobileShortcuts = [
      [
        {
          id: "legacy-escape",
          label: "Esc",
          action: { key: "Escape", ctrl: false, alt: false, shift: false },
        },
      ],
      [],
    ];
    await mount(false);
    expect(container.querySelector(".terminal-mobile-keys")).not.toBeNull();
    expect(
      container.querySelector(".terminal-mobile-side-shortcuts"),
    ).not.toBeNull();
    await act(async () => {
      visible = false;
      filesOpen = true;
      render();
    });
    expect(container.querySelector(".terminal-mobile-keys")).toBeNull();
    expect(
      container.querySelector(".terminal-mobile-side-shortcuts"),
    ).toBeNull();
    expect(open).toBe(false);
    await back();
    expect(container.querySelector(".terminal-mobile-keys")).not.toBeNull();
    expect(
      container.querySelector(".terminal-mobile-side-shortcuts"),
    ).not.toBeNull();
    expect(open).toBe(false);
  });

  test("returning from a secondary surface does not reauthorize or focus Direct", async () => {
    await mount();
    await click(".terminal-mobile-direct");
    const term = currentTerminal();
    const focusCount = term.focusCount;
    act(() => term.textarea.blur());
    await act(async () => {
      visible = false;
      filesOpen = true;
      render();
    });
    expect(selectedMode()).toBe("direct");
    await back();
    expect(selectedMode()).toBe("direct");
    expect(open).toBe(true);
    expect(term.focusCount).toBe(focusCount);
    expect(document.activeElement).not.toBe(term.textarea);
    await act(async () => {
      visible = false;
      filesOpen = true;
      render();
    });
    // An existing safety invalidation must still win over the hidden mode intent.
    await act(async () => {
      state.status = "disconnected";
      render();
    });
    expect(selectedMode()).toBe("composer");
    await act(async () => {
      state.status = "connected";
      render();
    });
    await back();
    expect(selectedMode()).toBe("composer");
    expect(term.focusCount).toBe(focusCount);
    expect(document.activeElement).not.toBe(term.textarea);
    expectInputBlocked();
  });

  test("persistent entries switch an open dock and synchronously reveal hidden input", async () => {
    await mount();
    await click(".terminal-mobile-direct");
    expect(document.activeElement).toBe(currentTerminal().textarea);
    await click(".terminal-mobile-message");
    expect(selectedMode()).toBe("composer");
    expectInputBlocked();
    await act(async () => {
      visible = false;
      filesOpen = true;
      render();
    });
    await click(".terminal-mobile-message");
    expect(visible).toBe(true);
    expect(filesOpen).toBe(false);
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Terminal input draft"]'),
    );
    expectInputBlocked();
    await click(".terminal-mobile-direct");
    expect(selectedMode()).toBe("direct");
    expect(document.activeElement).toBe(currentTerminal().textarea);
    expect(
      container.querySelectorAll(".terminal-mobile-input-bar"),
    ).toHaveLength(1);
  });

  test("global navigation survives input, hidden views and pane replacement without opening stdin", async () => {
    browser.history.pushState(null, "", "/terminal");
    await mount();
    const bar = container.querySelector(".mobile-bottom-bar");
    expect(bar?.querySelector(".terminal-mobile-message")).not.toBeNull();
    expect(
      container.querySelector(".terminal-shell .terminal-mobile-input-bar"),
    ).toBeNull();
    await click(".terminal-mobile-message");
    await click(".mobile-appbar-more");
    expect(moreOpen).toBe(true);
    await back();
    expect(moreOpen).toBe(false);
    expect(open).toBe(true);
    expectInputBlocked();
    await act(async () => {
      visible = false;
      filesOpen = true;
      viewKey = "new-pane";
      render();
    });
    expect(container.querySelector(".mobile-bottom-bar")).toBe(bar);
    expect(bar?.querySelector(".terminal-mobile-input-bar")).not.toBeNull();
    await click(".mobile-appbar-more");
    await click(".mobile-appbar-tabs");
    expect(moreOpen).toBe(false);
    expect(tabsOpen).toBe(true);
    await back();
    expect(tabsOpen).toBe(false);
    expect(filesOpen).toBe(true);
    expect(open).toBe(true);
    await back();
    expect(filesOpen).toBe(false);
    expect(open).toBe(true);
    expectInputBlocked();
  });

  test("empty workspace keeps both navigation entries available", async () => {
    await mount();
    await act(async () => {
      state.panes = [];
      render();
    });
    const tabs = container.querySelector<HTMLButtonElement>(
      ".mobile-appbar-tabs",
    )!;
    expect(tabs.disabled).toBe(false);
    expect(tabs.querySelector(".mobile-appbar-count")?.textContent).toBe("0");
    expect(container.querySelector(".terminal-mobile-input-bar")).toBeNull();
    await click(".mobile-appbar-tabs");
    expect(tabsOpen).toBe(true);
    await click(".mobile-appbar-more");
    expect(tabsOpen).toBe(false);
    expect(moreOpen).toBe(true);
    await act(async () => {
      document.dispatchEvent(
        new browser.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }) as unknown as KeyboardEvent,
      );
    });
    expect(moreOpen).toBe(false);
  });

  test("manual mode choices survive close and reopen without opening stdin", async () => {
    await mount();
    await setOpen(true);
    await choose("direct");
    expect(selectedMode()).toBe("direct");
    expect(savedMode()).toBe("direct");
    expect(document.activeElement).toBe(currentTerminal().textarea);
    await click('[aria-label="Close terminal input"]');
    expect(
      container.querySelector(".terminal-composer")?.hasAttribute("data-open"),
    ).toBe(false);
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
      expect(selectedMode()).toBe(
        change === "inactive split" ? undefined : "composer",
      );
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
  async function pasteFile(
    target: Element = currentTerminal().textarea,
    count = 1,
  ) {
    await act(async () => {
      const event = new browser.Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", {
        value: {
          items: Array.from({ length: count }, () => ({
            kind: "file",
            type: "image/png",
            getAsFile: () =>
              new browser.File(["x"], "a.png", { type: "image/png" }),
          })),
          getData: () => "",
        },
      });
      target.dispatchEvent(event as unknown as Event);
    });
  }
  const pathCalls = () =>
    calls.filter((call) => call.method === "pane.send_input");
  test("desktop file paste keeps its existing terminal destination without a mobile mode choice", async () => {
    mobileLayout = false;
    const media = browser.matchMedia;
    browser.matchMedia = ((query: string) => ({
      ...media(query),
      matches: false,
    })) as typeof browser.matchMedia;
    try {
      await mount();
      const target = container.querySelector<HTMLTextAreaElement>(
        '.terminal-shell[data-pane-id="pane-a"] .xterm-helper-textarea',
      )!;
      act(() => target.focus());
      await pasteFile(target);
      expect(uploads).toHaveLength(1);
      await act(async () => uploads[0].resolve("/tmp/desktop.png"));
      expect(pathCalls()).toHaveLength(1);
      expect(readTerminalComposerDraft(draftKey)).toBe("");
      expect(notices).toHaveLength(0);
    } finally {
      browser.matchMedia = media;
    }
  });
  test("Direct file paste inserts formatted paths without Enter and preserves draft/caret", async () => {
    await mount();
    await act(async () =>
      writeTerminalComposerDraft(draftKey, "untouched draft"),
    );
    await choose("direct");
    await pasteFile();
    expect(uploads).toHaveLength(1);
    await act(async () => uploads[0].resolve("'/tmp/a b.png'"));
    expect(pathCalls()).toEqual([
      {
        method: "pane.send_input",
        params: { pane_id: "pane-a", text: "'/tmp/a b.png' ", keys: [] },
      },
    ]);
    expect(readTerminalComposerDraft(draftKey)).toBe("untouched draft");
    expect(notices).toHaveLength(0);
  });
  for (const transition of [
    "mode",
    "pane",
    "connection",
    "hidden",
    "unmount",
    "ime",
    "rpc",
  ] as const) {
    test(`Direct late upload after ${transition} retains the original path and reports failure`, async () => {
      await mount();
      await choose("direct");
      await pasteFile();
      if (transition === "mode") await choose("composer");
      if (transition === "pane") {
        await patch({ selectedPaneId: "pane-b" });
        await patch({ selectedPaneId: "pane-a" });
        await choose("direct");
      }
      if (transition === "connection") await patch({ connectionGeneration: 2 });
      if (transition === "hidden") {
        visible = false;
        await act(async () => render());
      }
      if (transition === "unmount") {
        await act(async () => root!.unmount());
        root = null;
      }
      if (transition === "ime")
        await act(async () =>
          currentTerminal().textarea.dispatchEvent(
            new browser.CompositionEvent("compositionstart", {
              bubbles: true,
            }) as unknown as Event,
          ),
        );
      if (transition === "rpc") failPathInput = true;
      await act(async () => uploads[0].resolve("/tmp/recover.png"));
      expect(pathCalls()).toHaveLength(transition === "rpc" ? 1 : 0);
      expect(readTerminalComposerDraft(draftKey)).toContain("/tmp/recover.png");
      expect(
        notices.some(
          (notice) =>
            notice.message === "Path insertion failed" &&
            notice.detail?.includes("/tmp/recover.png"),
        ),
      ).toBe(true);
    });
  }
  test("Composer terminal drop/paste delivery stays in the original draft", async () => {
    await mount();
    const editor = container.querySelector(".terminal-composer-input")!;
    await pasteFile(editor);
    await act(async () => uploads[0].resolve("/tmp/composer.png"));
    expect(pathCalls()).toHaveLength(0);
    expect(readTerminalComposerDraft(draftKey)).toContain("/tmp/composer.png");
  });
  test("Direct partial batch failure keeps successful earlier paths without input", async () => {
    await mount();
    await choose("direct");
    await pasteFile(undefined, 2);
    await act(async () => uploads[0].resolve("/tmp/first.png"));
    await act(async () => uploads[1].reject(new Error("second upload failed")));
    expect(pathCalls()).toHaveLength(0);
    expect(readTerminalComposerDraft(draftKey)).toContain("/tmp/first.png");
  });
  async function pickFile(
    input = container.querySelector<HTMLInputElement>('input[type="file"]')!,
  ) {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new browser.File(["x"], "file.txt")],
    });
    await act(async () =>
      input.dispatchEvent(
        new browser.Event("change", { bubbles: true }) as unknown as Event,
      ),
    );
  }
  test("Direct picker binds the opening target, even after switching panes before selection", async () => {
    await mount();
    await choose("direct");
    await click('[aria-label="Add a file"]');
    const openedInput =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await patch({ selectedPaneId: "pane-b" });
    await pickFile(openedInput);
    expect(uploads).toHaveLength(1);
    await act(async () => uploads[0].resolve("/tmp/picker.txt"));
    expect(pathCalls()).toHaveLength(0);
    expect(readTerminalComposerDraft(draftKey)).toContain("/tmp/picker.txt");
    expect(
      readTerminalComposerDraft(
        terminalComposerDraftKey("connection-a", 1, "pane-b", "terminal-b"),
      ),
    ).toBe("");
    expect(
      notices.some((notice) => notice.message === "Path insertion failed"),
    ).toBe(true);
  });
  test("cancelled file picker does not retain a stale Direct destination", async () => {
    await mount();
    await choose("direct");
    await click('[aria-label="Add a file"]');
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () =>
      input.dispatchEvent(new browser.Event("cancel") as unknown as Event),
    );
    await choose("composer");
    await click('[aria-label="Add a file"]');
    await pickFile();
    await act(async () => uploads[0].resolve("/tmp/current.txt"));
    expect(pathCalls()).toHaveLength(0);
    expect(readTerminalComposerDraft(draftKey)).toContain("/tmp/current.txt");
    expect(notices).toHaveLength(0);
  });
  test("returning from an initially hidden view uses the current upload destination", async () => {
    visible = false;
    await mount();
    visible = true;
    await act(async () => render());
    await choose("direct");
    await pasteFile();
    await act(async () => uploads[0].resolve("/tmp/visible.png"));
    expect(pathCalls()).toHaveLength(1);
    expect(notices).toHaveLength(0);
  });
  test("Direct file picker and terminal file drop reuse no-Enter input", async () => {
    await mount();
    await choose("direct");
    await click('[aria-label="Add a file"]');
    await pickFile();
    await act(async () => uploads[0].resolve("/tmp/picker.txt"));
    const drop = new browser.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [new browser.File(["x"], "drop.txt")],
        items: [],
        getData: () => "",
      },
    });
    await act(async () =>
      currentTerminal().textarea.dispatchEvent(drop as unknown as Event),
    );
    expect(uploads).toHaveLength(2);
    await act(async () => uploads[1].resolve("/tmp/drop.txt"));
    expect(pathCalls().map((call) => call.params)).toEqual([
      { pane_id: "pane-a", text: "/tmp/picker.txt ", keys: [] },
      { pane_id: "pane-a", text: "/tmp/drop.txt ", keys: [] },
    ]);
    expect(readTerminalComposerDraft(draftKey)).toBe("");
  });

  test("closing Composer shortcuts or opening Commands reveals the upper-right shortcut capsule and coordinates focus", async () => {
    showMobileKeys = true;
    mobileShortcuts = [
      [
        {
          id: "test-esc",
          label: "Esc",
          action: { key: "Escape", ctrl: false, alt: false, shift: false },
        },
      ],
      [],
    ];
    await mount();
    const editor = container.querySelector<HTMLTextAreaElement>(
      ".terminal-composer-input",
    )!;
    const composerShortcuts = container.querySelector<HTMLElement>(
      ".terminal-composer-shortcuts",
    )!;
    // While the Composer dock is closed, the upper-right shortcut capsule is visible.
    expect(composerShortcuts.hidden).toBe(true);
    expect(container.querySelector(".terminal-mobile-keys")).not.toBeNull();

    // Opening the Composer dock with shortcuts open hides the upper-right capsule.
    await setOpen(true);
    expect(composerShortcuts.hidden).toBe(false);
    expect(container.querySelector(".terminal-mobile-keys")).toBeNull();

    // Closing the Composer shortcut keyboard reveals the upper-right capsule.
    await click(".terminal-composer-shortcuts-toggle");
    expect(composerShortcuts.hidden).toBe(true);
    const mobileKeys = container.querySelector<HTMLElement>(
      ".terminal-mobile-keys",
    );
    expect(mobileKeys).not.toBeNull();
    expect(mobileKeys?.classList.contains("is-open")).toBe(false);

    // Focus multiline Composer draft and use upper-right capsule without losing focus or expanded state.
    await act(async () => {
      writeTerminalComposerDraft(draftKey, "line 1\nline 2");
      editor.focus();
    });
    expect(document.activeElement).toBe(editor);
    expect(
      container
        .querySelector(".terminal-composer")
        ?.hasAttribute("data-expanded"),
    ).toBe(true);

    await click(".terminal-mobile-keys-toggle");
    expect(
      container
        .querySelector(".terminal-mobile-keys")
        ?.classList.contains("is-open"),
    ).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect(
      container
        .querySelector(".terminal-composer")
        ?.hasAttribute("data-expanded"),
    ).toBe(true);

    const beforeEsc = calls.filter(
      (call) => call.method === "terminal.input",
    ).length;
    await click('[aria-label="Send Escape"]');
    expect(
      calls.filter((call) => call.method === "terminal.input"),
    ).toHaveLength(beforeEsc + 1);
    expect(document.activeElement).toBe(editor);
    expect(readTerminalComposerDraft(draftKey)).toBe("line 1\nline 2");

    // Switching to Direct mode while Composer shortcuts are closed keeps the upper-right capsule interactive and preserves Direct focus.
    await click(".terminal-mobile-direct");
    expect(selectedMode()).toBe("direct");
    expect(document.activeElement).toBe(currentTerminal().textarea);
    expect(
      container
        .querySelector(".terminal-composer")
        ?.hasAttribute("data-expanded"),
    ).toBe(false);
    await click('[aria-label="Send Escape"]');
    expect(
      calls.filter((call) => call.method === "terminal.input"),
    ).toHaveLength(beforeEsc + 2);
    expect(document.activeElement).toBe(currentTerminal().textarea);

    // Re-opening Composer shortcuts hides the upper-right capsule and resets its open state.
    await click(".terminal-composer-shortcuts-toggle");
    expect(composerShortcuts.hidden).toBe(false);
    expect(container.querySelector(".terminal-mobile-keys")).toBeNull();

    // Opening the command picker covers Composer shortcuts and reveals the upper-right capsule.
    await click(".terminal-composer-commands-toggle");
    expect(composerShortcuts.hidden).toBe(true);
    expect(
      container
        .querySelector(".terminal-composer-shortcuts-toggle")
        ?.getAttribute("aria-label"),
    ).toBe("Show terminal shortcuts");
    expect(container.querySelector(".terminal-mobile-keys")).not.toBeNull();
    expect(
      container
        .querySelector(".terminal-mobile-keys")
        ?.classList.contains("is-open"),
    ).toBe(false);

    // Closing the command picker restores Composer shortcuts and hides the upper-right capsule.
    await click('[aria-label="Dismiss commands"]');
    expect(composerShortcuts.hidden).toBe(false);
    expect(
      container
        .querySelector(".terminal-composer-shortcuts-toggle")
        ?.getAttribute("aria-label"),
    ).toBe("Hide terminal shortcuts");
    expect(container.querySelector(".terminal-mobile-keys")).toBeNull();
  });

  test("repeated switching between Direct and Composer via button or textarea focus stays coherent and preserves drafts", async () => {
    await mount();
    const editor = container.querySelector<HTMLTextAreaElement>(
      ".terminal-composer-input",
    )!;
    const directButton = container.querySelector<HTMLButtonElement>(
      ".terminal-mobile-direct",
    )!;
    await act(async () =>
      writeTerminalComposerDraft(draftKey, "persistent\ndraft"),
    );

    for (let i = 0; i < 3; i++) {
      await click(".terminal-mobile-direct");
      expect(selectedMode()).toBe("direct");
      expect(savedMode()).toBe("direct");
      expect(directButton.getAttribute("aria-pressed")).toBe("true");
      expect(document.activeElement).toBe(currentTerminal().textarea);
      expect(currentTerminal().options.disableStdin).toBe(false);
      expect(
        container
          .querySelector(".terminal-composer")
          ?.hasAttribute("data-expanded"),
      ).toBe(false);

      // Focusing textarea directly from Direct mode switches to Composer, remembers the choice, and expands multiline draft.
      await act(async () => editor.focus());
      expect(selectedMode()).toBe("composer");
      expect(savedMode()).toBe("composer");
      expect(directButton.getAttribute("aria-pressed")).toBe("false");
      expect(document.activeElement).toBe(editor);
      expectInputBlocked();
      expect(
        container
          .querySelector(".terminal-composer")
          ?.hasAttribute("data-expanded"),
      ).toBe(true);
      expect(readTerminalComposerDraft(draftKey)).toBe("persistent\ndraft");
    }

    // Focusing textarea after Commands temporarily switched from Direct to Composer also remembers Composer.
    await click(".terminal-mobile-direct");
    expect(savedMode()).toBe("direct");
    await click(".terminal-composer-commands-toggle");
    expect(selectedMode()).toBe("composer");
    expect(savedMode()).toBe("direct");
    await act(async () => editor.focus());
    expect(savedMode()).toBe("composer");

    expect(
      calls.filter(
        (call) =>
          call.method === "terminal.input" || call.method === "pane.input",
      ),
    ).toHaveLength(0);
  });
}
