import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bridge, type ConnectionClient, type TerminalPush } from "./api";
import {
  annotationDraftStorageKey,
  readReviewAnnotations,
  writeReviewAnnotations,
  type ReviewAnnotation,
} from "./annotations";
import { roamgateLocalStorage } from "./browserStorage";
import { __storeTesting, store } from "./store";
import {
  resourceScopeForWorkspace,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
} from "./workspaceResource";
import type { Pane, Workspace } from "./types";

export async function checkAnnotationUX(
  check: (condition: boolean, message: string) => void,
) {
  store.init = () => {};
  void fetch("/event", {
    method: "POST",
    body: `annotation viewport ${innerWidth}x${innerHeight}`,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const until = async (predicate: () => unknown, label: string) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`Annotation UX: ${label}`);
  };
  const click = (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error(`Missing ${selector}`);
    flushSync(() => button.click());
  };
  const type = (selector: string, text: string) => {
    const input = document.querySelector<HTMLTextAreaElement>(selector)!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const workspace: Workspace = {
    workspace_id: "review-workspace",
    number: 1,
    label: "Review",
    cwd: "/repo",
    focused: true,
    pane_count: 2,
    tab_count: 2,
    agent_status: "idle",
    active_tab_id: "review-tab",
  };
  const pane: Pane = {
    pane_id: "review-pane",
    terminal_id: "review-terminal",
    workspace_id: workspace.workspace_id,
    tab_id: "review-tab",
    focused: true,
    agent: "Agent",
    agent_status: "idle",
    revision: 1,
  };
  const otherPane: Pane = {
    ...pane,
    pane_id: "other-pane",
    terminal_id: "other-terminal",
    tab_id: "other-tab",
    focused: false,
    agent: "Other agent",
  };
  let cols = 80,
    rows = 24;
  let delivery: ReturnType<typeof Promise.withResolvers<object>> | null = null;
  const sent: Record<string, unknown>[] = [];
  let terminalInputCount = 0;
  const listeners = new Set<(frame: TerminalPush) => void>();
  const previousOnTerminal = bridge.onTerminal;
  const previousFocusPane = store.focusPane;
  const previousFocusTab = store.focusTab;
  store.focusTab = async () => {};
  let focusedPane = "";
  store.focusPane = async (id) => {
    focusedPane = id;
  };
  bridge.onTerminal = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const client: ConnectionClient = {
    connectionId: "annotation-test",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: (generation) => generation === 1,
    call: async (method, params = {}) => {
      if (method === "terminal.input") terminalInputCount++;
      if (method === "terminal.attach") {
        cols = Number(params.cols);
        rows = Number(params.rows);
      }
      if (method === "pane.send_input") {
        sent.push(params);
        delivery = Promise.withResolvers<object>();
        return delivery.promise;
      }
      if (method === "file.list")
        return {
          workspace_id: workspace.workspace_id,
          path: "",
          root: "/repo",
          entries: [],
          truncated: false,
        };
      if (method === "git.diff_summary") return { entries: [], counts: {} };
      return {};
    },
  };
  bridge.connection = () => client;
  const key = annotationDraftStorageKey(
    resourceScopeForWorkspace(client.connectionId, workspace),
  );
  const file: ReviewAnnotation = {
    id: "file-comment",
    source: "file",
    anchor: "line",
    path: "example.ts",
    line: 1,
    quote: "run();",
    comment: "Handle failure",
    createdAt: 1,
  };
  writeReviewAnnotations(roamgateLocalStorage, key, [file]);
  __storeTesting.replaceState({
    ...store.get(),
    status: "connected",
    activeConnectionId: client.connectionId,
    connectionGeneration: 1,
    serverRuntimeGeneration: 1,
    lastRefresh: 1,
    workspaces: [workspace],
    panes: [pane, otherPane],
    tabs: [
      {
        tab_id: otherPane.tab_id,
        workspace_id: pane.workspace_id,
        number: 2,
        label: "Other tab",
        focused: false,
        pane_count: 1,
        agent_status: "idle",
      },
      {
        tab_id: pane.tab_id,
        workspace_id: pane.workspace_id,
        number: 1,
        label: "Review",
        focused: true,
        pane_count: 1,
        agent_status: "idle",
      },
    ],
    selectedPaneId: pane.pane_id,
    layout: {
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      zoomed: false,
      area: { x: 0, y: 0, width: 80, height: 24 },
      focused_pane_id: pane.pane_id,
      panes: [
        {
          pane_id: pane.pane_id,
          focused: true,
          rect: { x: 0, y: 0, width: 80, height: 24 },
        },
      ],
      splits: [],
    },
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const draft = () => readReviewAnnotations(roamgateLocalStorage, key);
  const paint = () =>
    listeners.forEach((listener) =>
      listener({
        connection_id: client.connectionId,
        connection_generation: 1,
        terminal_id: pane.terminal_id,
        bytes: btoa("\x1b[2J\x1b[HSelected terminal output"),
        full: true,
        width: cols,
        height: rows,
      }),
    );
  const select = async () => {
    paint();
    await settle();
    const screen = document.querySelector<HTMLElement>(".xterm-screen")!;
    const rect = screen.getBoundingClientRect();
    for (const [target, type, column, buttons] of [
      [screen, "mousedown", 0.1, 1],
      [document, "mousemove", 8.1, 1],
      [document, "mouseup", 8.1, 0],
    ] as const) {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          buttons,
          clientX: rect.left + (column * rect.width) / cols,
          clientY: rect.top + rect.height / rows / 2,
        }),
      );
    }
    await until(
      () => document.querySelector(".terminal-annotation-action"),
      "selection action missing",
    );
    click(".terminal-annotation-action");
    await until(
      () =>
        document.activeElement?.getAttribute("aria-label") === "Review comment",
      "composer did not focus",
    );
  };
  const requestAnnotation = (id: string) =>
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_INSPECTOR_REQUEST_EVENT, {
        detail: {
          connectionId: client.connectionId,
          generation: 1,
          workspaceId: pane.workspace_id,
          view: "files",
          annotation: {
            id,
            source: "terminal",
            anchor: "quote",
            paneId: pane.pane_id,
            title: "Agent",
            quote: "Selected",
            comment: id,
            createdAt: 1,
          },
        },
      }),
    );
  const openInspector = () =>
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_INSPECTOR_REQUEST_EVENT, {
        detail: {
          connectionId: client.connectionId,
          generation: 1,
          workspaceId: pane.workspace_id,
          view: "files",
        },
      }),
    );
  try {
    flushSync(() => root.render(<App />));
    await until(
      () => document.querySelector(".xterm-screen") && listeners.size,
      "terminal did not mount",
    );
    check(
      !document.querySelector(".workspace-inspector"),
      "Inspector should start closed",
    );
    flushSync(() => {
      requestAnnotation("before-mount-1");
      requestAnnotation("before-mount-2");
      openInspector();
      check(
        !document.querySelector(".workspace-inspector"),
        "handoff fixture mounted before persistence assertion",
      );
      check(
        draft().length === 3,
        "successive saves were not persisted before Inspector mount/navigation",
      );
    });
    await until(
      () => document.querySelectorAll(".annotation-card").length === 3,
      "pending handoffs were overwritten by navigation",
    );
    click('button[aria-label="Delete comment 3"]');
    click('button[aria-label="Delete comment 2"]');
    const setItem = roamgateLocalStorage.setItem;
    try {
      roamgateLocalStorage.setItem = (storageKey, value) => {
        if (storageKey === key) throw new Error("Storage full");
        setItem(storageKey, value);
      };
      flushSync(() => {
        requestAnnotation("memory-fallback-1");
        requestAnnotation("memory-fallback-2");
        openInspector();
      });
      await until(
        () => document.querySelectorAll(".annotation-card").length === 3,
        "storage failure lost pending in-memory comments",
      );
      check(
        draft().length === 1,
        "storage failure fixture unexpectedly persisted",
      );
    } finally {
      roamgateLocalStorage.setItem = setItem;
    }
    click('button[aria-label="Delete comment 3"]');
    click('button[aria-label="Delete comment 2"]');
    click('button[aria-label="Close Workspace Inspector"]');
    await select();
    for (const text of ["P", "Please", "Please explain"]) {
      type(".annotation-composer-popover textarea", text);
      flushSync(() => store.clearNotice());
      await settle();
      check(
        document.querySelector<HTMLTextAreaElement>(
          ".annotation-composer-popover textarea",
        )?.value === text,
        "composer reset text on rerender",
      );
    }
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    check(
      !document.querySelector(".annotation-composer-popover"),
      "Escape did not cancel composer",
    );
    check(draft().length === 1, "cancel persisted a comment");
    check(
      terminalInputCount === 0,
      "selection or composer typing leaked terminal input",
    );
    check(
      !!document.activeElement?.closest(".xterm"),
      "cancel did not restore terminal focus",
    );
    await select();
    type(".annotation-composer-popover textarea", "Explain output");
    const textarea = document.activeElement;
    textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    check(
      document.activeElement?.textContent === "Add comment",
      "composer keyboard focus did not wrap",
    );
    click('.annotation-composer-popover button[type="submit"]');
    await until(
      () => document.querySelectorAll(".annotation-card").length === 2,
      "terminal creation did not open mixed draft",
    );
    await settle();
    check(
      document.activeElement?.getAttribute("aria-label") === "Comment 2",
      "new annotation did not receive focus",
    );
    check(
      draft()[1]?.source === "terminal" && draft()[1]?.quote === "Selected",
      "terminal selection quote was not captured",
    );
    check(
      document
        .querySelectorAll(".annotation-card")[1]
        ?.textContent?.includes("Terminal") === true,
      "source label missing",
    );
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      for (const width of ["680px", "350px"]) {
        const slot = document.querySelector<HTMLElement>(
          ".workspace-inspector-slot",
        )!;
        slot.style.width = width;
        await settle();
        const panel = document
          .querySelector(".annotation-panel")!
          .getBoundingClientRect();
        check(
          panel.width > 250 &&
            panel.width <= 680 &&
            panel.left >= 0 &&
            panel.right <= innerWidth + 1,
          `${theme}/${width}: annotation panel overflow`,
        );
      }
    }
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });
    click(".annotation-delivery-actions button:first-child");
    await settle();
    check(
      copied.includes("terminal pane") && draft().length === 2,
      "Copy did not retain mixed draft",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "pre-fill did not start");
    check(
      sent[0]?.pane_id === pane.pane_id &&
        JSON.stringify(sent[0]?.keys) === "[]",
      "pre-fill did not use source pane without Enter",
    );
    type(".annotation-card:last-child textarea", "Edited while sending");
    delivery!.resolve({});
    delivery = null;
    await settle();
    check(
      draft().length === 1 && draft()[0]?.comment === "Edited while sending",
      "delivery erased concurrent edits or retained delivered file",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "second pre-fill did not start");
    delivery!.reject(new Error("Synthetic delivery failure"));
    delivery = null;
    await settle();
    check(draft().length === 1, "failed delivery erased work");
    type(".annotation-card textarea", " ");
    check(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".annotation-delivery-actions button",
        ),
      ].every((button) => button.disabled),
      "blank delivery not disabled",
    );
    type(".annotation-card textarea", "Final feedback");
    click('button[aria-label="Agent pane"]');
    await until(
      () => document.querySelector('[cmdk-item][data-value="other-pane"]'),
      "other agent option missing",
    );
    click('[cmdk-item][data-value="other-pane"]');
    await settle();
    click('button[aria-label="Close Workspace Inspector"]');
    flushSync(() => openInspector());
    await settle();
    check(
      document
        .querySelector('button[aria-label="Agent pane"]')
        ?.textContent?.includes("Other agent") === true,
      "Inspector reopening reset explicit delivery destination",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "final pre-fill did not start");
    delivery!.resolve({});
    delivery = null;
    await settle();
    check(
      draft().length === 0,
      "successful pre-fill did not clear delivered comment",
    );
    const goToAgent = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".annotation-panel button"),
    ).find((button) => button.textContent === "Go to agent");
    check(
      !!goToAgent,
      "successful pre-fill did not offer destination navigation",
    );
    flushSync(() => goToAgent?.click());
    await settle();
    check(
      focusedPane === otherPane.pane_id &&
        document
          .querySelector(".workspace-inspector-slot")
          ?.classList.contains("is-closed") === true,
      "Go to agent did not reveal destination terminal",
    );
    flushSync(() => requestAnnotation("retired-delivery"));
    await until(
      () => document.querySelectorAll(".annotation-card").length === 1,
      "retired draft missing",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "retired pre-fill did not start");
    // Leaving and returning remounts the inspector owner while its RPC is pending.
    flushSync(() => root.render(null));
    flushSync(() => root.render(<App />));
    await until(
      () => document.querySelector(".xterm-screen"),
      "returned terminal missing",
    );
    flushSync(() => requestAnnotation("new-after-return"));
    await until(
      () => document.querySelectorAll(".annotation-card").length === 2,
      "returned draft missing",
    );
    focusedPane = "";
    delivery!.resolve({});
    delivery = null;
    await settle();
    check(focusedPane === "", "retired delivery navigated to a terminal");
    check(
      draft().length === 2 &&
        document.querySelectorAll(".annotation-card").length === 2,
      "retired completion changed returned draft",
    );
    check(
      store.get().notice?.detail?.includes("Original draft retained") === true,
      "retired completion did not explain retained draft",
    );
    __storeTesting.replaceState({ ...store.get(), panes: [], layout: null });
    flushSync(() => store.clearNotice());
    await settle();
    check(
      draft().every((item) => item.stale) &&
        document
          .querySelector(".annotation-card")
          ?.textContent?.includes("Pane unavailable") === true,
      "missing terminal pane was not marked unavailable",
    );
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_INSPECTOR_REQUEST_EVENT, {
        detail: {
          connectionId: client.connectionId,
          generation: 0,
          workspaceId: pane.workspace_id,
          view: "files",
          annotation: {
            id: "old",
            source: "terminal",
            anchor: "quote",
            paneId: pane.pane_id,
            title: "old",
            quote: "old",
            comment: "old",
            createdAt: 1,
          },
        },
      }),
    );
    await settle();
    check(draft().length === 2, "stale connection request added annotation");
  } finally {
    root.unmount();
    container.remove();
    bridge.onTerminal = previousOnTerminal;
    store.focusPane = previousFocusPane;
    store.focusTab = previousFocusTab;
  }
}
