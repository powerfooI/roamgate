import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import {
  ASSISTANT_MAX_WORKSPACES,
  type AssistantAction,
  type AssistantSnapshot,
} from "../../../shared/assistant";
import * as assistant from "../assistant";
import type { ConnectionSummary } from "../api";
import * as storeModule from "../store";
import { terminalFocusBlockedByOverlay } from "../terminalFocus";
import { AssistantPanel, assistantAuthUrl } from "./AssistantPanel";

test("assistant sign-in links only open explicit http or https destinations", () => {
  expect(assistantAuthUrl("https://example.com/device?code=test")).toBe(
    "https://example.com/device?code=test",
  );
  expect(assistantAuthUrl("http://localhost:1455/callback")).toBe(
    "http://localhost:1455/callback",
  );
  for (const value of [
    undefined,
    "",
    "/login",
    "//example.com",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://password@example.com/",
  ])
    expect(assistantAuthUrl(value)).toBeNull();
});

// Keep real DOM focus and React effects isolated from the hook spies above.
if (process.env.ROAMGATE_ASSISTANT_ACTION_DOM_TEST !== "1") {
  test("assistant action interactions in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ASSISTANT_ACTION_DOM_TEST: "1" },
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
  test("Ranger refreshes workspace context when a host becomes ready without resetting edits", async () => {
    const { Window } = await import("happy-dom");
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
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { createRoot } = await import("react-dom/client");
    const { bridge } = await import("../api");
    const previousStore = storeModule.store.get();
    const local: ConnectionSummary = {
      id: "local",
      label: "Local",
      source: "saved",
      is_default: true,
      state: "ready",
      generation: 1,
    };
    const ssh: ConnectionSummary = {
      ...local,
      id: "sshtx1",
      label: "SSH host",
      is_default: false,
      state: "connecting",
      generation: 0,
    };
    storeModule.__storeTesting.replaceState({
      ...previousStore,
      activeConnectionId: local.id,
      defaultConnectionId: local.id,
      connectionGeneration: local.generation,
      connections: [local, ssh],
    });
    const localWorkspace = {
      connection_id: local.id,
      workspace_id: "local-project",
      connection_label: local.label,
      label: "Local project",
      runtime_generation: local.generation,
    };
    const remoteWorkspace = {
      ...localWorkspace,
      connection_id: ssh.id,
      connection_label: ssh.label,
      workspace_id: "remote-project",
      label: "Remote project",
    };
    const snapshot: AssistantSnapshot = {
      instance_id: "bridge",
      revision: 1,
      config: {
        provider: "",
        model: "",
        credential_source: "assistant",
        allowed_workspaces: [],
      },
      providers: [],
      models: [],
      messages: [],
      running: false,
      error: null,
      auth: null,
    };
    const state = spyOn(assistant, "useAssistantState").mockReturnValue({
      snapshot,
      loading: false,
      error: null,
      connectionStatus: "connected",
      supported: true,
      draft: "",
    });
    const unavailable = "Connection sshtx1 is not ready.";
    let contextResult = {
      workspaces: [localWorkspace],
      errors: [unavailable],
    };
    let deferNext = false;
    let resolveStale: (result: typeof contextResult) => void = () => {};
    const context = spyOn(bridge, "call").mockImplementation(async (method) => {
      expect(method).toBe("bridge.assistant.context");
      if (deferNext) {
        deferNext = false;
        return await new Promise<typeof contextResult>((resolve) => {
          resolveStale = resolve;
        });
      }
      return contextResult;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const checkbox = (label: string) =>
      Array.from(
        container.querySelectorAll<HTMLLabelElement>(
          ".assistant-workspace-choice",
        ),
      )
        .find((item) => item.textContent?.includes(label))
        ?.querySelector<HTMLInputElement>("input");
    const catalog = async (remote: ConnectionSummary) => {
      await React.act(async () =>
        storeModule.__storeTesting.applyCatalog([local, remote], local.id),
      );
    };
    try {
      await React.act(async () =>
        root.render(
          React.createElement(AssistantPanel, {
            open: true,
            floating: true,
            mobile: false,
            onClose() {},
            onToggleFloating() {},
            onOpenSource() {},
          }),
        ),
      );
      expect(context).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(unavailable);
      expect(checkbox("Remote project")).toBeUndefined();
      expect(
        container.querySelector(".assistant-panel-title strong")?.textContent,
      ).toBe("Ranger");
      expect(
        container.querySelector(".assistant-panel-experimental")?.textContent,
      ).toBe("Experimental");
      await React.act(async () => checkbox("Local project")!.click());
      expect(checkbox("Local project")?.checked).toBe(true);

      // Catalog polls may rebuild and reorder DTOs without changing runtime state.
      await React.act(async () =>
        storeModule.__storeTesting.applyCatalog(
          [{ ...ssh, label: "SSH metadata refreshed" }, { ...local }],
          local.id,
        ),
      );
      expect(context).toHaveBeenCalledTimes(1);
      contextResult = {
        workspaces: [localWorkspace, remoteWorkspace],
        errors: [],
      };
      await catalog({ ...ssh, state: "ready", generation: 1 });
      expect(context).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain(unavailable);
      expect(checkbox("Remote project")?.checked).toBe(false);
      expect(checkbox("Local project")?.checked).toBe(true);
      expect(snapshot.config.allowed_workspaces).toEqual([]);

      // A replacement runtime refreshes again, and its response wins over older reads.
      deferNext = true;
      await catalog({ ...ssh, state: "ready", generation: 2 });
      expect(context).toHaveBeenCalledTimes(3);
      contextResult = {
        workspaces: [
          localWorkspace,
          {
            ...remoteWorkspace,
            label: "Latest remote project",
            runtime_generation: 3,
          },
        ],
        errors: [],
      };
      await catalog({ ...ssh, state: "ready", generation: 3 });
      expect(context).toHaveBeenCalledTimes(4);
      await React.act(async () =>
        resolveStale({ workspaces: [localWorkspace], errors: [unavailable] }),
      );
      expect(container.textContent).not.toContain(unavailable);
      expect(checkbox("Latest remote project")?.checked).toBe(false);
      expect(checkbox("Local project")?.checked).toBe(true);
    } finally {
      await React.act(async () => root.unmount());
      context.mockRestore();
      state.mockRestore();
      storeModule.__storeTesting.replaceState(previousStore);
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("conversation map follows visible messages and preserves reading position across streamed updates", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      NodeFilter: browser.NodeFilter,
      Event: browser.Event,
      DOMParser: browser.DOMParser,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    Object.defineProperties(browser, {
      requestAnimationFrame: {
        value: (callback: FrameRequestCallback) => {
          frames.set(++frameId, callback);
          return frameId;
        },
      },
      cancelAnimationFrame: { value: (id: number) => frames.delete(id) },
    });
    const observers = new Set<ResizeObserverStub>();
    class ResizeObserverStub {
      targets = new Set<Element>();
      constructor(public callback: () => void) {
        observers.add(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      disconnect() {
        observers.delete(this);
      }
    }
    Object.defineProperty(browser, "ResizeObserver", {
      value: ResizeObserverStub,
    });
    const flushFrames = async () => {
      await React.act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      });
    };
    const { createRoot } = await import("react-dom/client");
    const { bridge } = await import("../api");
    const message = (id: string, text = id) => ({
      id,
      role: "user" as const,
      text,
      sent_at: "2026-10-04T00:00:00Z",
      tools: [],
      sources: [],
    });
    const clientState = {
      snapshot: {
        instance_id: "bridge",
        session_id: "session-one",
        revision: 1,
        config: {
          provider: "provider",
          model: "model",
          credential_source: "assistant",
          allowed_workspaces: [],
        },
        providers: [
          { id: "provider", label: "Provider", methods: [], configured: true },
        ],
        models: [{ id: "model", label: "Model", provider: "provider" }],
        messages: [
          message("short"),
          message("long"),
          message("third"),
          { ...message("last"), role: "assistant" },
        ],
        running: false,
        error: null,
        auth: null,
      } as AssistantSnapshot,
      loading: false,
      error: null,
      connectionStatus: "connected" as const,
      supported: true,
      draft: "",
    };
    const state = spyOn(assistant, "useAssistantState").mockImplementation(
      () => clientState,
    );
    const context = spyOn(bridge, "call").mockResolvedValue({ workspaces: [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const bounds = new Map([
      ["short", { top: 0, height: 60 }],
      ["long", { top: 78, height: 480 }],
      ["third", { top: 576, height: 80 }],
      ["last", { top: 674, height: 220 }],
    ]);
    let position = 0;
    const scrollHeight = () =>
      Math.max(
        200,
        ...[...bounds.values()].map((rect) => rect.top + rect.height + 12),
      );
    const list = () =>
      container.querySelector<HTMLDivElement>(".assistant-panel-list")!;
    const wave = () =>
      container.querySelector<HTMLDivElement>(".assistant-conversation-wave")!;
    const layout = () => {
      const scroller = list();
      if (!scroller) return;
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 200 },
        offsetHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, get: scrollHeight },
        scrollTop: {
          configurable: true,
          get: () => position,
          set: (next: number) => {
            position = Math.max(0, Math.min(next, scrollHeight() - 200));
          },
        },
      });
      scroller.getBoundingClientRect = () =>
        new browser.DOMRect(100, 200, 300, 200) as DOMRect;
      scroller
        .querySelectorAll<HTMLElement>(".assistant-message")
        .forEach((section) => {
          section.getBoundingClientRect = () => {
            const rect = bounds.get(section.dataset.messageId!)!;
            return new browser.DOMRect(
              100,
              200 + rect.top - position,
              300,
              rect.height,
            ) as DOMRect;
          };
        });
      if (wave())
        wave().getBoundingClientRect = () =>
          new browser.DOMRect(410, 250, 26, 160) as DOMRect;
    };
    const render = async () => {
      await React.act(async () =>
        root.render(
          React.createElement(AssistantPanel, {
            open: true,
            floating: true,
            mobile: false,
            onClose() {},
            onToggleFloating() {},
            onOpenSource() {},
          }),
        ),
      );
      layout();
      await flushFrames();
    };
    const scroll = async (top: number) => {
      await React.act(async () => {
        list().scrollTop = top;
        list().dispatchEvent(new browser.Event("scroll") as unknown as Event);
      });
      await flushFrames();
    };
    const pointAt = (index: number) =>
      250 + ((index + 0.5) / clientState.snapshot.messages.length) * 160;
    const key = async (value: string) => {
      const event = new browser.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      });
      await React.act(async () =>
        wave().dispatchEvent(event as unknown as Event),
      );
      expect(event.defaultPrevented).toBe(true);
      await scroll(position);
    };
    const visible = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          ".assistant-conversation-mark.is-visible",
        ),
        (mark) => mark.dataset.messageId,
      );
    const stream = async () => {
      clientState.snapshot = {
        ...clientState.snapshot,
        running: true,
        messages: clientState.snapshot.messages.map((entry, index, all) =>
          index === all.length - 1
            ? { ...entry, text: `${entry.text} streamed` }
            : entry,
        ),
      };
      await render();
      await React.act(async () =>
        observers.forEach((observer) => observer.callback()),
      );
      await flushFrames();
    };
    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (item) =>
          item.getAttribute("aria-label") === label ||
          item.textContent?.trim() === label,
      )!;
      await React.act(async () => button.click());
    };
    try {
      await render();
      await scroll(200);
      expect(visible()).toEqual(["long"]);
      expect(wave().getAttribute("aria-valuenow")).toBe("2");
      expect(
        [...observers].some((observer) =>
          observer.targets.has(
            list().querySelector("[data-message-id='long']")!,
          ),
        ),
      ).toBe(true);
      container.scrollTop = 35;
      document.documentElement.scrollTop = 45;
      await React.act(async () =>
        wave().dispatchEvent(
          new browser.MouseEvent("click", {
            clientY: pointAt(1),
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      await scroll(position);
      expect(position).toBe(66);
      expect(document.activeElement).toBe(wave());
      bounds.get("last")!.height += 100;
      await stream();
      expect(position).toBe(66);
      expect(visible()).toEqual(["long"]);
      await key("Home");
      expect(position).toBe(0);
      await key("ArrowDown");
      expect(position).toBe(66);
      await key("End");
      expect(position).toBe(662);
      expect(container.scrollTop).toBe(35);
      expect(document.documentElement.scrollTop).toBe(45);
      await scroll(scrollHeight());
      bounds.get("last")!.height += 100;
      await stream();
      expect(position).toBe(scrollHeight() - 200);
      expect(visible()).toEqual(["last"]);

      await clickButton("Ranger settings");
      expect(wave()).toBeNull();
      await clickButton("Chat");
      layout();
      await flushFrames();
      expect(wave()).not.toBeNull();
      clientState.snapshot = {
        ...clientState.snapshot,
        running: false,
        messages: Array.from({ length: 80 }, (_, index) =>
          message(`message-${index}`, `Message ${index}`),
        ),
      };
      bounds.clear();
      clientState.snapshot.messages.forEach((entry, index) =>
        bounds.set(entry.id, { top: index * 24, height: 16 }),
      );
      await render();
      await React.act(async () =>
        wave().dispatchEvent(
          new browser.PointerEvent("pointermove", {
            clientY: pointAt(40),
            pointerType: "mouse",
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      expect(
        container.querySelector("[role='tooltip']")?.textContent,
      ).toContain("Message 40");
      clientState.snapshot = {
        ...clientState.snapshot,
        messages: [
          ...clientState.snapshot.messages.slice(1),
          message("message-80", "Message 80"),
        ],
      };
      bounds.clear();
      clientState.snapshot.messages.forEach((entry, index) =>
        bounds.set(entry.id, { top: index * 24, height: 16 }),
      );
      await render();
      expect(
        container.querySelector("[role='tooltip']")?.textContent,
      ).toContain("Message 40");
      expect(
        container.querySelector("[role='tooltip'] strong > span")?.textContent,
      ).toBe("40 / 80");
      await React.act(async () =>
        wave().dispatchEvent(
          new browser.MouseEvent("click", {
            clientY: pointAt(39),
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      await scroll(position);
      expect(position).toBe(39 * 24 - 12);
      expect(visible()).toContain("message-40");
      expect(
        container.querySelector(
          ".assistant-conversation-mark[data-message-id='message-0']",
        ),
      ).toBeNull();

      clientState.snapshot = {
        ...clientState.snapshot,
        session_id: "session-two",
        messages: [message("new-session", "New session message")],
      };
      bounds.clear();
      bounds.set("new-session", { top: 0, height: 300 });
      await render();
      expect(position).toBe(scrollHeight() - 200);
      expect(visible()).toEqual(["new-session"]);
      expect(container.querySelector("[role='tooltip']")).toBeNull();
      clientState.snapshot = { ...clientState.snapshot, messages: [] };
      await render();
      expect(wave()).toBeNull();
      expect(observers.size).toBe(0);
    } finally {
      await React.act(async () => root.unmount());
      state.mockRestore();
      context.mockRestore();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("action cards preserve proposals, focus, confirmation guards and terminal results", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { createRoot } = await import("react-dom/client");
    const { bridge } = await import("../api");
    const workspace = {
      connection_id: "local",
      workspace_id: "project",
      connection_label: "Local host",
      label: "Project",
      runtime_generation: 2,
    };
    const unsafe = '<img src=x onerror="bad()">\n<script>bad()</script>\nEND';
    const proposal: AssistantAction = {
      connection_id: workspace.connection_id,
      workspace_id: workspace.workspace_id,
      connection_label: workspace.connection_label,
      workspace_label: workspace.label,
      runtime_generation: workspace.runtime_generation,
      id: "prompt-action",
      kind: "send_prompt",
      status: "pending",
      created_at: "2026-10-03T00:00:00Z",
      params: {
        pane_id: "pane-one",
        terminal_id: "internal-terminal",
        prompt: unsafe,
        ["__proto__"]: "Unknown field value",
      },
      summary: "Send the following text to the selected agent",
      detail: "",
    };
    const proposals: AssistantAction[] = [
      proposal,
      {
        ...proposal,
        id: "workspace-action",
        kind: "create_workspace",
        params: { cwd: "/projects/new", label: "New project" },
      },
      {
        ...proposal,
        id: "worktree-action",
        kind: "create_worktree",
        status: "uncertain",
        params: {
          cwd: "/projects/repo",
          branch: "review/change",
          base: "Latest origin default branch",
          setup_hook: unsafe,
          setup_hook_enabled: "true",
        },
        detail: "Connection lost. Check the target before proposing again.",
      },
      {
        ...proposal,
        id: "tab-action",
        kind: "create_tab",
        params: {
          cwd: "/projects/repo",
          tab_id: "tab-original",
          pane_id: "pane-original",
          terminal_id: "terminal-original",
        },
        summary: "Create a terminal tab in Project",
      },
      {
        ...proposal,
        id: "split-action",
        kind: "split_pane",
        status: "succeeded",
        params: {
          cwd: "/projects/repo",
          tab_id: "tab-original",
          pane_id: "pane-original",
          terminal_id: "terminal-original",
          direction: "right",
        },
        summary: "Split the source pane to the right",
        detail:
          "Created pane pane-new with terminal terminal-new in tab tab-original.",
      },
      {
        ...proposal,
        id: "agent-action",
        kind: "start_agent",
        status: "failed",
        params: { agent: "pi", pane_id: "pane-two", prompt: "Review now" },
        detail: "Agent could not start: <b>unavailable</b>",
      },
    ];
    const snapshot: AssistantSnapshot = {
      instance_id: "bridge",
      revision: 1,
      config: {
        provider: "provider",
        model: "model",
        credential_source: "assistant",
        allowed_workspaces: [workspace],
      },
      providers: [
        { id: "provider", label: "Provider", methods: [], configured: true },
      ],
      models: [{ id: "model", label: "Model", provider: "provider" }],
      messages: [
        {
          id: "answer",
          role: "assistant",
          text: "",
          sent_at: proposal.created_at,
          tools: [],
          sources: [],
          actions: proposals,
        },
      ],
      running: false,
      error: null,
      auth: null,
    };
    const clientState = {
      snapshot,
      loading: false,
      error: null,
      connectionStatus: "connected",
      supported: true,
      draft: "Next question",
    };
    let contextWorkspaces = [workspace];
    let acknowledge: (snapshot: AssistantSnapshot) => void = () => {};
    const call = spyOn(assistant, "callAssistant").mockImplementation(
      async (action) => {
        if (action === "action.confirm")
          return new Promise<AssistantSnapshot>((resolve) => {
            acknowledge = resolve;
          });
        return clientState.snapshot;
      },
    );
    const send = spyOn(assistant, "sendAssistant").mockResolvedValue();
    const state = spyOn(assistant, "useAssistantState").mockImplementation(
      () => clientState as ReturnType<typeof assistant.useAssistantState>,
    );
    const context = spyOn(bridge, "call").mockImplementation(async (method) => {
      expect(method).toBe("bridge.assistant.context");
      return { workspaces: contextWorkspaces };
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    const terminalFrame = () => {
      if (!terminalFocusBlockedByOverlay(document.activeElement, document))
        terminal.focus();
    };
    let panelOpen = true;
    let panelFloating = true;
    let panelMobile = false;
    let panelKey = "configured";
    const close = mock(() => {
      panelOpen = false;
    });
    const toggleFloating = mock(() => {
      panelFloating = !panelFloating;
    });
    const render = async () => {
      await React.act(async () =>
        root.render(
          React.createElement(AssistantPanel, {
            key: panelKey,
            open: panelOpen,
            floating: panelFloating,
            mobile: panelMobile,
            onClose: close,
            onToggleFloating: toggleFloating,
            onOpenSource() {},
          }),
        ),
      );
    };
    const button = (label: string, parent: ParentNode = container) => {
      const found = Array.from(
        parent.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (item) =>
          item.getAttribute("aria-label") === label ||
          item.textContent?.trim() === label,
      );
      if (!found) throw new Error(`Missing button ${label}`);
      return found;
    };
    const card = (name: string) =>
      container.querySelector<HTMLElement>(`[aria-label="${name} proposal"]`)!;
    const setStatus = (id: string, status: AssistantAction["status"]) => {
      clientState.snapshot = {
        ...clientState.snapshot,
        messages: clientState.snapshot.messages.map((message) => ({
          ...message,
          actions: message.actions?.map((action) =>
            action.id === id ? { ...action, status } : action,
          ),
        })),
      };
    };
    try {
      await render();
      await React.act(async () => button("Maximize Ranger").click());
      expect(
        container.querySelector(".assistant-panel.is-maximized"),
      ).not.toBeNull();
      expect(button("Restore Ranger").getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(container.querySelector('[aria-label="Pin Ranger"]')).toBeNull();
      expect(container.querySelector('[aria-label="Float Ranger"]')).toBeNull();
      expect(container.querySelector("textarea")?.value).toBe("Next question");
      expect(call).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await React.act(async () => button("Close Ranger").click());
      await render();
      expect(container.querySelector(".assistant-panel")).toBeNull();
      panelOpen = true;
      await render();
      expect(
        container.querySelector(".assistant-panel.is-maximized"),
      ).not.toBeNull();
      expect(container.querySelector("textarea")?.value).toBe("Next question");
      await React.act(async () => button("Restore Ranger").click());
      expect(
        container.querySelector(".assistant-panel.is-floating"),
      ).not.toBeNull();
      expect(
        container.querySelector(".assistant-panel.is-maximized"),
      ).toBeNull();
      expect(button("Pin Ranger")).toBeDefined();

      panelFloating = false;
      await render();
      await React.act(async () => button("Maximize Ranger").click());
      await React.act(async () =>
        button("Restore Ranger").dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(
        container.querySelector(".assistant-panel.is-maximized"),
      ).toBeNull();
      expect(
        container.querySelector(".assistant-panel.is-floating"),
      ).toBeNull();
      expect(close).toHaveBeenCalledTimes(1);
      await React.act(async () => button("Maximize Ranger").click());
      expect(container.querySelector('[aria-label="Float Ranger"]')).toBeNull();
      await React.act(async () => button("Restore Ranger").click());
      await React.act(async () => button("Float Ranger").click());
      await render();
      expect(toggleFloating).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(".assistant-panel.is-maximized"),
      ).toBeNull();
      expect(
        container.querySelector(".assistant-panel.is-floating"),
      ).not.toBeNull();
      panelMobile = true;
      await render();
      expect(
        container.querySelector('[aria-label="Maximize Ranger"]'),
      ).toBeNull();
      expect(
        container.querySelector(".assistant-panel.is-mobile"),
      ).not.toBeNull();
      panelMobile = false;
      await render();
      clientState.snapshot = {
        ...clientState.snapshot,
        tasks: [],
        session_id: "00000000-0000-4000-8000-000000000001",
        sessions: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            title: "Current chat",
            created_at: proposal.created_at,
            updated_at: proposal.created_at,
            message_count: 1,
          },
        ],
      };
      await render();
      expect(
        container.querySelectorAll(".assistant-chat-toolbar button"),
      ).toHaveLength(2);
      await React.act(async () => button("History").click());
      expect(
        container.querySelector('[aria-label="Saved Ranger chats"]'),
      ).not.toBeNull();
      await React.act(async () => button("Close Ranger chat history").click());
      await React.act(async () => button("Tasks").click());
      expect(
        container.querySelector('[aria-label="Ranger tasks"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Message Ranger"]'),
      ).toBeNull();
      await React.act(async () => button("New task").click());
      const taskForm = container.querySelector<HTMLFormElement>(
        '[aria-label="Create task"]',
      )!;
      const taskName = taskForm.querySelector<HTMLInputElement>(
        '[aria-label="Task name"]',
      )!;
      const taskPrompt = taskForm.querySelector<HTMLTextAreaElement>(
        '[aria-label="Task prompt"]',
      )!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(taskName, "Keep my task draft");
        taskName.dispatchEvent(new Event("input", { bubbles: true }));
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(taskPrompt, "Read status tomorrow");
        taskPrompt.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await React.act(async () => button("Chat").click());
      expect(
        container.querySelector('[aria-label="Message Ranger"]')?.textContent,
      ).toBe("Next question");
      expect(taskForm.closest<HTMLElement>(".assistant-tasks")!.hidden).toBe(
        true,
      );
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Message Ranger",
      );
      await React.act(async () => button("Tasks").click());
      expect(container.querySelector('[aria-label="Create task"]')).toBe(
        taskForm,
      );
      expect(taskName.value).toBe("Keep my task draft");
      expect(taskPrompt.value).toBe("Read status tomorrow");
      expect(document.activeElement).toBe(taskName);
      await React.act(async () => button("Ranger settings").click());
      expect(taskForm.closest<HTMLElement>(".assistant-tasks")!.hidden).toBe(
        true,
      );
      await React.act(async () => button("Tasks").click());
      expect(container.querySelector('[aria-label="Create task"]')).toBe(
        taskForm,
      );
      expect(taskName.value).toBe("Keep my task draft");
      expect(taskPrompt.value).toBe("Read status tomorrow");
      await React.act(async () => button("Cancel", taskForm).click());
      await React.act(async () => button("Chat").click());
      const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(document.activeElement).toBe(input);
      terminalFrame();
      expect(document.activeElement).toBe(input);
      expect(container.querySelectorAll(".assistant-action-card")).toHaveLength(
        6,
      );
      expect(card("Send prompt").textContent).toContain("Local hostlocal");
      expect(card("Send prompt").textContent).toContain("Projectproject");
      expect(card("Send prompt").textContent).not.toContain(
        "Runtime generation",
      );
      expect(card("Send prompt").textContent).not.toContain(
        "internal-terminal",
      );
      expect(card("Send prompt").textContent).toContain("pane-one");
      expect(
        card("Send prompt").querySelector('[aria-label="Exact prompt"]')
          ?.textContent,
      ).toBe(unsafe);
      expect(container.querySelector("img, script, b")).toBeNull();
      expect(card("Send prompt").textContent).toContain(
        "__proto__Unknown field value",
      );
      expect(card("Create worktree").textContent).toContain("review/change");
      expect(card("Create worktree").textContent).toContain(
        "Base branchLatest origin default branch",
      );
      expect(card("Create worktree").textContent).toContain(
        `Setup command${unsafe}`,
      );
      expect(card("Create worktree").textContent).toContain(
        "Run setup commandEnabled",
      );
      expect(card("Create worktree").textContent).toContain(
        "Outcome uncertain",
      );
      expect(card("Create worktree").querySelector("button")).toBeNull();
      expect(card("Start agent").textContent).toContain("<b>unavailable</b>");
      expect(card("Start agent").querySelector("button")).toBeNull();
      for (const name of ["Create tab", "Split pane"]) {
        expect(card(name).textContent).toContain(
          "Working directory/projects/repo",
        );
        expect(card(name).textContent).toContain("Source tabtab-original");
        expect(card(name).textContent).toContain("Source panepane-original");
        expect(card(name).textContent).toContain(
          "Source terminalterminal-original",
        );
      }
      expect(card("Split pane").textContent).toContain("Split directionRight");
      expect(card("Split pane").textContent).toContain("pane-new");
      expect(card("Split pane").textContent).toContain("terminal-new");
      expect(card("Split pane").querySelector("button")).toBeNull();
      expect(card("Send prompt").querySelector("dl")?.tabIndex).toBe(0);
      clientState.snapshot = {
        ...clientState.snapshot,
        messages: clientState.snapshot.messages.map((message) => ({
          ...message,
          actions: message.actions?.map((action) =>
            action.kind === "create_worktree"
              ? {
                  ...action,
                  params: { ...action.params, setup_hook_enabled: "false" },
                }
              : action.kind === "split_pane"
                ? { ...action, params: { ...action.params, direction: "down" } }
                : action,
          ),
        })),
      };
      await render();
      expect(card("Create worktree").textContent).toContain(
        "Run setup commandDisabled",
      );
      expect(card("Split pane").textContent).toContain("Split directionDown");
      await React.act(async () =>
        container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
      );
      expect(button("Send").disabled).toBe(false);
      clientState.snapshot = { ...clientState.snapshot, running: true };
      await render();
      expect(document.activeElement).toBe(input);
      expect(button("Confirm action", card("Send prompt")).disabled).toBe(true);
      expect(button("Confirm action", card("Create tab")).disabled).toBe(true);
      expect(button("Cancel", card("Send prompt")).disabled).toBe(true);
      expect(button("Stop").title).toContain("confirmed actions continue");
      await React.act(async () =>
        button("Confirm action", card("Send prompt")).click(),
      );
      expect(call).not.toHaveBeenCalled();

      clientState.snapshot = { ...clientState.snapshot, running: false };
      await render();
      const confirm = button("Confirm action", card("Send prompt"));
      await React.act(async () => {
        confirm.click();
        confirm.click();
      });
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith("action.confirm", {
        action_id: proposal.id,
      });
      expect(document.activeElement).toBe(card("Send prompt"));
      terminalFrame();
      expect(document.activeElement).toBe(card("Send prompt"));
      expect(button("Confirm action", card("Create workspace")).disabled).toBe(
        true,
      );
      setStatus(proposal.id, "executing");
      await React.act(async () => acknowledge(clientState.snapshot));
      await render();
      expect(card("Send prompt").querySelector("button")).toBeNull();
      expect(document.activeElement).toBe(card("Send prompt"));
      expect(button("Send").disabled).toBe(true);
      expect(button("New chat").disabled).toBe(true);
      expect(button("Confirm action", card("Create workspace")).disabled).toBe(
        true,
      );
      expect(button("Cancel", card("Create workspace")).disabled).toBe(true);
      expect(button("Confirm action", card("Create tab")).disabled).toBe(true);
      expect(
        container
          .querySelector('[aria-label="Ranger conversation"]')
          ?.getAttribute("aria-busy"),
      ).toBe("true");
      await React.act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      expect(send).not.toHaveBeenCalled();
      await React.act(async () => button("Ranger settings").click());
      expect(button("Save connection").disabled).toBe(true);
      expect(container.querySelectorAll("fieldset:disabled")).toHaveLength(2);
      button("Refresh Ranger workspaces").focus();
      terminalFrame();
      expect(document.activeElement).toBe(button("Refresh Ranger workspaces"));
      await React.act(async () => button("Chat").click());
      card("Send prompt").focus();

      const callsBeforeCompletion = context.mock.calls.length;
      contextWorkspaces = [
        workspace,
        { ...workspace, workspace_id: "new", label: "New project" },
      ];
      setStatus(proposal.id, "succeeded");
      await render();
      expect(context.mock.calls.length).toBe(callsBeforeCompletion + 1);
      terminalFrame();
      expect(document.activeElement).toBe(card("Send prompt"));
      terminal.focus();
      terminalFrame();
      expect(document.activeElement).toBe(terminal);
      await React.act(async () => button("Ranger settings").click());
      const newWorkspace = Array.from(container.querySelectorAll("label")).find(
        (item) => item.textContent?.includes("New project"),
      );
      expect(
        newWorkspace?.querySelector<HTMLInputElement>("input")?.checked,
      ).toBe(false);
      expect(clientState.snapshot.config.allowed_workspaces).toEqual([
        workspace,
      ]);
      await React.act(async () => button("Chat").click());
      expect(card("Send prompt").textContent).toContain("Succeeded");
      await React.act(async () =>
        button("Cancel", card("Create workspace")).click(),
      );
      expect(call).toHaveBeenLastCalledWith("action.cancel", {
        action_id: "workspace-action",
      });
      setStatus("workspace-action", "cancelled");
      await render();
      expect(card("Create workspace").textContent).toContain("Cancelled");
      expect(card("Create workspace").querySelector("button")).toBeNull();
      expect(proposal.params.prompt).toBe(unsafe);
      await React.act(async () =>
        button("Confirm action", card("Create tab")).click(),
      );
      expect(call).toHaveBeenLastCalledWith("action.confirm", {
        action_id: "tab-action",
      });
      setStatus("tab-action", "succeeded");
      await React.act(async () => acknowledge(clientState.snapshot));
      await render();
      expect(card("Create tab").textContent).toContain("Succeeded");
      expect(card("Create tab").querySelector("button")).toBeNull();
      clientState.snapshot = {
        ...clientState.snapshot,
        messages: clientState.snapshot.messages.map((message) => {
          const legacy = { ...message };
          delete legacy.actions;
          return legacy;
        }),
      };
      await render();
      expect(container.querySelector(".assistant-action-card")).toBeNull();
      expect(button("Send").disabled).toBe(false);
      clientState.snapshot = {
        ...clientState.snapshot,
        config: { ...clientState.snapshot.config, provider: "", model: "" },
      };
      panelKey = "unconfigured";
      await render();
      expect(
        container.querySelector(".assistant-panel-settings"),
      ).not.toBeNull();
      expect(button("Chat").disabled).toBe(false);
      await React.act(async () => button("Ranger settings").click());
      expect(container.querySelector(".assistant-panel-settings")).toBeNull();
      expect(button("Ranger settings").getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(
        container.querySelector('[aria-label="Ranger conversation"]'),
      ).not.toBeNull();
      expect(
        container.querySelector<HTMLTextAreaElement>(
          '[aria-label="Message Ranger"]',
        )?.value,
      ).toBe(clientState.draft);
      expect(button("Send").disabled).toBe(true);
      expect(
        container.querySelector(".assistant-setup-notice")?.textContent,
      ).toContain("Connect a provider");
      await React.act(async () => button("Model settings").click());
      expect(
        container.querySelector(".assistant-panel-settings"),
      ).not.toBeNull();
      await React.act(async () => button("Chat").click());
      expect(container.querySelector(".assistant-panel-settings")).toBeNull();
      clientState.snapshot = { ...clientState.snapshot, revision: 2 };
      await render();
      expect(container.querySelector(".assistant-panel-settings")).toBeNull();
      await React.act(async () => button("Ranger settings").click());
      expect(
        container.querySelector(".assistant-panel-settings"),
      ).not.toBeNull();
      await React.act(async () => button("Ranger settings").click());
      expect(container.querySelector(".assistant-panel-settings")).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      for (const spy of [context, state, send, call]) spy.mockRestore();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

test("assistant explicitly selects scope, guards IME sends, and hides without stopping work", async () => {
  const workspace = {
    connection_id: "local",
    workspace_id: "workspace",
    connection_label: "Local",
    label: "Project",
    runtime_generation: 1,
  };
  const snapshot: AssistantSnapshot = {
    instance_id: "bridge",
    revision: 1,
    config: {
      provider: "provider",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: [workspace],
    },
    providers: [
      {
        id: "provider",
        label: "Provider",
        methods: ["api_key"],
        configured: true,
      },
    ],
    models: [{ id: "model", label: "Model", provider: "provider" }],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
  const clientState = {
    snapshot,
    loading: false,
    error: null,
    connectionStatus: "connected" as "connected" | "disconnected",
    supported: true,
    draft: "Explain the changes",
  };
  const states: unknown[] = [];
  const refs: React.RefObject<unknown>[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let open = true;
  let elements: React.ReactElement<Record<string, unknown>>[] = [];
  const close = mock(() => {
    open = false;
  });
  const stop = mock(async () => snapshot);
  const refresh = mock(async () => {});
  let acknowledge: () => void = () => {};
  const send = mock(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const spies = [
    spyOn(storeModule, "useStoreSelector").mockImplementation((selector) =>
      selector(storeModule.store.get()),
    ),
    spyOn(assistant, "useAssistantState").mockImplementation(() => clientState),
    spyOn(assistant, "sendAssistant").mockImplementation(send),
    spyOn(assistant, "callAssistant").mockImplementation(stop),
    spyOn(assistant, "refreshAssistant").mockImplementation(refresh),
    spyOn(React, "useState").mockImplementation(
      <S>(
        initial?: S | (() => S),
      ): [S, React.Dispatch<React.SetStateAction<S>>] => {
        const index = stateIndex++;
        if (!(index in states))
          states[index] =
            index === 2
              ? [workspace]
              : typeof initial === "function"
                ? (initial as () => S)()
                : initial;
        return [
          states[index] as S,
          (value) => {
            states[index] =
              typeof value === "function"
                ? (value as (previous: S) => S)(states[index] as S)
                : value;
          },
        ];
      },
    ),
    spyOn(React, "useRef").mockImplementation(
      (current) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
    ),
    spyOn(React, "useEffect").mockImplementation(() => {}),
  ];
  function visit(node: React.ReactNode) {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as React.ReactNode);
    });
  }
  function render() {
    stateIndex = refIndex = 0;
    elements = [];
    const panel = AssistantPanel({
      open,
      floating: true,
      mobile: false,
      onClose: close,
      onToggleFloating() {},
      onOpenSource() {},
    });
    visit(panel);
    return panel;
  }
  function find(prop: string, value: unknown) {
    const element = elements.find((item) => item.props[prop] === value);
    if (!element) throw new Error(`Missing ${prop}=${String(value)}`);
    return element;
  }
  function invoke(
    prop: string,
    value: unknown,
    handler: string,
    event: unknown = {},
  ) {
    const callback = find(prop, value).props[handler] as (
      event: unknown,
    ) => void;
    callback(event);
    render();
  }
  const key = (isComposing = false, shiftKey = false) => ({
    key: "Enter",
    shiftKey,
    nativeEvent: { isComposing },
    preventDefault: mock(() => {}),
  });
  try {
    render();
    invoke("aria-label", "Message Ranger", "onKeyDown", key());
    expect(send).not.toHaveBeenCalled();
    invoke("type", "checkbox", "onChange");
    invoke("aria-label", "Message Ranger", "onKeyDown", key(true));
    invoke("aria-label", "Message Ranger", "onKeyDown", key(false, true));
    invoke("aria-label", "Message Ranger", "onCompositionStart");
    invoke("aria-label", "Message Ranger", "onKeyDown", key());
    expect(send).not.toHaveBeenCalled();
    invoke("aria-label", "Message Ranger", "onCompositionEnd");
    invoke("aria-label", "Message Ranger", "onKeyDown", key());
    invoke("aria-label", "Message Ranger", "onKeyDown", key());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Explain the changes", [
      { connection_id: "local", workspace_id: "workspace" },
    ]);
    acknowledge();
    await Promise.resolve();
    snapshot.running = true;
    render();
    invoke("aria-label", "Close Ranger", "onClick");
    expect(render()).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    open = true;
    render();
    expect(find("aria-label", "Message Ranger").props.value).toBe(
      "Explain the changes",
    );
    expect(find("children", "Scope stays fixed while working")).toBeDefined();

    snapshot.running = false;
    snapshot.providers.unshift({
      id: "not-saved",
      label: "Not saved",
      methods: ["api_key", "oauth"],
      configured: false,
    });
    snapshot.providers[1].credential_method = "oauth";
    snapshot.providers.push({
      id: "other",
      label: "Other provider",
      methods: ["api_key"],
      configured: true,
      credential_method: "api_key",
    });
    states[0] = true;
    states[1] = { ...snapshot.config, model: "unsaved-model" };
    render();
    expect(
      elements.filter(
        (item) => item.props.className === "assistant-provider-choice",
      ),
    ).toHaveLength(3);
    expect(find("children", "Saved login (OAuth)")).toBeDefined();
    expect(find("children", "API key saved")).toBeDefined();
    expect(find("aria-label", "Model provider").props.role).toBe("group");
    expect(find("aria-label", "Credential source").props.role).toBe("group");
    expect(
      find("aria-label", "Credential source").props.options,
    ).toBeUndefined();
    expect(find("aria-label", "Ranger connection").props["aria-pressed"]).toBe(
      true,
    );
    expect(
      find("aria-label", "Shared Pi credentials").props["aria-pressed"],
    ).toBe(false);
    expect(find("aria-label", "Model provider").props.options).toBeUndefined();
    expect(find("aria-label", "Ranger model").props.disabled).toBe(false);
    expect(find("className", "assistant-other-providers").props.open).toBe(
      false,
    );
    invoke("aria-label", "Search providers", "onChange", {
      currentTarget: { value: "  NOT-sa  " },
    });
    expect(
      elements.filter(
        (item) => item.props.className === "assistant-provider-choice",
      ),
    ).toHaveLength(1);
    expect(find("aria-label", "Select provider Not saved")).toBeDefined();
    expect(find("className", "assistant-other-providers").props.open).toBe(
      true,
    );
    expect(states[1]).toMatchObject({
      provider: "provider",
      model: "unsaved-model",
    });
    invoke("aria-label", "Search providers", "onChange", {
      currentTarget: { value: " OTHER PROVIDER " },
    });
    expect(find("aria-label", "Select provider Other provider")).toBeDefined();
    invoke("aria-label", "Search providers", "onChange", {
      currentTarget: { value: "no such provider" },
    });
    expect(find("children", "No providers match your search.").props.role).toBe(
      "status",
    );
    expect(states[1]).toMatchObject({
      provider: "provider",
      model: "unsaved-model",
    });
    invoke("aria-label", "Search providers", "onChange", {
      currentTarget: { value: "  " },
    });
    expect(
      elements.filter(
        (item) => item.props.className === "assistant-provider-choice",
      ),
    ).toHaveLength(3);
    expect(find("className", "assistant-other-providers").props.open).toBe(
      false,
    );
    invoke("aria-label", "Search providers", "onChange", {
      currentTarget: { value: "" },
    });
    invoke("aria-label", "Select provider Provider", "onClick");
    expect(states[1]).toMatchObject({
      provider: "provider",
      model: "unsaved-model",
    });
    invoke("aria-label", "Select provider Other provider", "onClick");
    expect(states[1]).toMatchObject({ provider: "other", model: "" });
    expect(find("aria-label", "Ranger model").props.disabled).toBe(true);
    expect(find("aria-label", "Ranger model").props.placeholder).toBe(
      "No models available",
    );
    expect(snapshot.config.provider).toBe("provider");
    expect(stop).not.toHaveBeenCalled();
    invoke("aria-label", "Refresh Ranger credentials", "onClick");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    await (
      find("aria-label", "Ranger connection").props
        .onClick as () => Promise<void>
    )();
    expect(stop).not.toHaveBeenCalled();
    const previousConfig = states[1] as AssistantSnapshot["config"];
    await (
      find("aria-label", "Shared Pi credentials").props
        .onClick as () => Promise<void>
    )();
    expect(stop).toHaveBeenLastCalledWith("configure", {
      config: {
        ...previousConfig,
        credential_source: "pi",
        provider: "",
        model: "",
      },
    });
    stop.mockClear();
    states[1] = { ...snapshot.config, provider: "", model: "" };
    render();
    expect(find("aria-label", "Ranger model").props.disabled).toBe(true);
    expect(find("aria-label", "Ranger model").props.placeholder).toBe(
      "Choose a provider first",
    );
    for (const source of ["assistant", "pi"] as const) {
      states[1] = { ...snapshot.config, credential_source: source };
      render();
      invoke("aria-label", "Select provider Not saved", "onClick");
      expect(find("aria-label", "Ranger model").props.disabled).toBe(true);
      expect(find("className", "assistant-other-providers").props.open).toBe(
        true,
      );
      invoke("aria-label", "Sign in to Not saved", "onClick");
      await Promise.resolve();
      await Promise.resolve();
      expect(stop).toHaveBeenLastCalledWith("auth.start", {
        provider: "not-saved",
        method: "oauth",
      });
      invoke("aria-label", "Enter API key for Not saved", "onClick");
      await Promise.resolve();
      await Promise.resolve();
      expect(stop).toHaveBeenLastCalledWith("auth.start", {
        provider: "not-saved",
        method: "api_key",
      });
    }
    stop.mockClear();
    snapshot.running = true;
    render();
    expect(
      find("aria-label", "Refresh Ranger credentials").props.disabled,
    ).toBe(true);

    snapshot.running = false;
    const offlineWorkspace = {
      connection_id: "offline",
      workspace_id: "workspace",
    };
    const otherConnectionWorkspace = { ...workspace, connection_id: "remote" };
    states[1] = { ...snapshot.config, allowed_workspaces: [offlineWorkspace] };
    states[2] = [workspace, otherConnectionWorkspace, workspace];
    render();
    invoke("aria-label", "Select all available Ranger workspaces", "onClick");
    expect(states[1]).toMatchObject({
      allowed_workspaces: [
        offlineWorkspace,
        { connection_id: "local", workspace_id: "workspace" },
        { connection_id: "remote", workspace_id: "workspace" },
      ],
    });
    expect(snapshot.config.allowed_workspaces).toEqual([workspace]);
    expect(stop).not.toHaveBeenCalled();
    expect(
      find("aria-label", "Select all available Ranger workspaces").props
        .disabled,
    ).toBe(true);
    states[4] = false;
    const largeCatalog = Array.from(
      { length: ASSISTANT_MAX_WORKSPACES },
      (_, index) => ({ ...workspace, workspace_id: `w${index}` }),
    );
    states[2] = largeCatalog;
    states[1] = {
      ...snapshot.config,
      allowed_workspaces: [
        ...largeCatalog.slice(0, ASSISTANT_MAX_WORKSPACES - 1),
        offlineWorkspace,
      ],
    };
    render();
    expect(
      find("aria-label", "Select all available Ranger workspaces").props
        .disabled,
    ).toBe(true);
    expect(
      find(
        "children",
        `Select up to ${ASSISTANT_MAX_WORKSPACES} workspaces individually; Select all exceeds this limit.`,
      ),
    ).toBeDefined();
    const choices = elements.filter((item) => item.props.type === "checkbox");
    expect(
      choices
        .slice(0, ASSISTANT_MAX_WORKSPACES - 1)
        .every((item) => !item.props.disabled),
    ).toBe(true);
    expect(choices[ASSISTANT_MAX_WORKSPACES - 1].props.disabled).toBe(true);
    expect(choices[ASSISTANT_MAX_WORKSPACES].props.disabled).toBeUndefined();
    (choices[0].props.onChange as () => void)();
    render();
    expect(
      elements
        .filter((item) => item.props.type === "checkbox")
        .every((item) => !item.props.disabled),
    ).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    invoke("aria-label", "Clear allowed Ranger workspaces", "onClick");
    expect(states[1]).toMatchObject({ allowed_workspaces: [] });
    expect(
      find("aria-label", "Clear allowed Ranger workspaces").props.disabled,
    ).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    states[2] = [workspace];
    states[4] = true;
    render();
    expect(
      find("aria-label", "Select all available Ranger workspaces").props
        .disabled,
    ).toBe(true);
    states[0] = false;
    snapshot.session_id = "00000000-0000-4000-8000-000000000001";
    snapshot.sessions = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        title: "Older investigation",
        created_at: "2026-10-03T10:00:00Z",
        updated_at: "2026-10-03T10:01:00Z",
        message_count: 2,
      },
      {
        id: snapshot.session_id,
        title: "Current investigation",
        created_at: "2026-10-04T00:00:00Z",
        updated_at: "2026-10-04T00:01:00Z",
        message_count: 1,
      },
    ];
    snapshot.messages = [
      {
        id: "current-message",
        role: "user",
        text: "Current conversation remains saved",
        sent_at: "2026-10-04T00:01:00Z",
        tools: [],
        sources: [],
        actions: [
          {
            id: "pending-tab",
            kind: "create_tab",
            status: "pending",
            connection_id: workspace.connection_id,
            connection_label: workspace.connection_label,
            workspace_id: workspace.workspace_id,
            workspace_label: workspace.label,
            runtime_generation: workspace.runtime_generation,
            created_at: "2026-10-04T00:01:00Z",
            params: {},
            summary: "Create a tab",
            detail: "",
          },
        ],
      },
    ];
    render();
    expect(find("children", "Current investigation")).toBeDefined();
    invoke("aria-label", "Ranger chat history", "onClick");
    expect(find("aria-label", "Saved Ranger chats")).toBeDefined();
    expect(
      elements
        .filter(
          (item) =>
            typeof item.props.title === "string" &&
            item.props.title.endsWith("investigation"),
        )
        .map((item) => item.props.title),
    ).toEqual(["Current investigation", "Older investigation"]);
    expect(find("title", "Current investigation").props.disabled).toBe(true);
    expect(find("title", "Older investigation").props.disabled).toBe(false);
    expect(
      find(
        "children",
        "Opening a chat cancels this chat's unconfirmed action previews.",
      ),
    ).toBeDefined();
    const messagesBeforeSwitch = snapshot.messages;
    for (const blocked of [
      "running",
      "executing",
      "disconnected",
      "auth",
      "busy",
    ]) {
      snapshot.running = blocked === "running";
      snapshot.messages[0].actions![0].status =
        blocked === "executing" ? "executing" : "pending";
      clientState.connectionStatus =
        blocked === "disconnected" ? "disconnected" : "connected";
      snapshot.auth =
        blocked === "auth"
          ? {
              id: "login",
              provider: "provider",
              status: "waiting",
              message: "Sign in",
            }
          : null;
      states[6] = blocked === "busy";
      render();
      expect(find("aria-label", "Ranger chat history").props.disabled).toBe(
        true,
      );
      expect(find("title", "Older investigation").props.disabled).toBe(true);
      invoke("title", "Older investigation", "onClick");
      expect(stop).not.toHaveBeenCalled();
    }
    states[6] = false;
    snapshot.running = false;
    snapshot.auth = null;
    clientState.connectionStatus = "connected";
    snapshot.messages[0].actions![0].status = "pending";
    render();
    invoke("title", "Older investigation", "onClick");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("select_session", {
      session_id: "00000000-0000-4000-8000-000000000002",
    });
    expect(snapshot.messages).toBe(messagesBeforeSwitch);
    await Promise.resolve();
    await Promise.resolve();
    render();
    expect(
      find("aria-label", "Ranger chat history").props["aria-expanded"],
    ).toBe(false);
    const newChat = elements.find(
      (item) =>
        item.type === "button" &&
        React.Children.toArray(item.props.children as React.ReactNode).includes(
          " New chat",
        ),
    )!;
    (newChat.props.onClick as () => void)();
    render();
    expect(find("title", "Start a new Ranger chat?").props.message).toContain(
      "current chat will be saved in History",
    );
    expect(find("title", "Start a new Ranger chat?").props.message).toContain(
      "Unconfirmed action previews will be cancelled",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
});
