import { StrictMode } from "react";
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
  WORKSPACE_ANNOTATION_REQUEST_EVENT,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
} from "./workspaceResource";
import type { FilePreview, Pane, Workspace } from "./types";

export async function checkAnnotationUX(
  check: (condition: boolean, message: string) => void,
) {
  store.init = () => {};
  void fetch("/event", {
    method: "POST",
    body: `annotation viewport ${innerWidth}x${innerHeight}`,
  });
  const mobile = () => document.documentElement.dataset.layout === "mobile";
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
  const toggleAnnotations = () =>
    click(
      mobile()
        ? 'button[aria-label="Show review annotations"]'
        : ".tabbar-utilities button:last-child",
    );
  const showAnnotations = () => {
    if (
      !document.querySelector(".annotation-panel") ||
      (mobile() && !document.querySelector(".body.mobile-view-annotations"))
    )
      toggleAnnotations();
  };
  const visible = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    return (
      !!element &&
      element.getBoundingClientRect().width > 0 &&
      getComputedStyle(element).visibility !== "hidden"
    );
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
    worktree: {
      repo_key: "review-repo",
      repo_name: "Review",
      repo_root: "/repo",
      checkout_path: "/repo",
      gui_settings_key: "review-repo",
      is_linked_worktree: false,
    },
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
  let previewDelivery: ReturnType<
    typeof Promise.withResolvers<FilePreview>
  > | null = null;
  let client: ConnectionClient = {
    connectionId: "annotation-test",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => store.get().connectionGeneration === 1,
    acceptsServerGeneration: (generation) => generation === 1,
    call: async (method, params = {}) => {
      if (method === "agent_session.get")
        return { status: "ok", stats: { turns: 0, records: 0 } };
      if (method === "agent_history.get")
        return {
          status: "ok",
          history_version: 2,
          mode: "snapshot",
          window_limit: 200,
          cursor: { epoch: "test", revision: 1 },
          entries: [],
        };
      if (method === "terminal.input") terminalInputCount++;
      if (method === "terminal.attach" || method === "terminal.resize") {
        cols = Number(params.cols);
        rows = Number(params.rows);
      }
      if (method === "pane.send_input") {
        sent.push(params);
        delivery = Promise.withResolvers<object>();
        return delivery.promise;
      }
      if (method === "file.read") {
        previewDelivery = Promise.withResolvers<FilePreview>();
        return previewDelivery.promise;
      }
      if (method === "file.list")
        return {
          workspace_id: workspace.workspace_id,
          path: "",
          root: "/repo",
          entries: [
            {
              name: "example.ts",
              path: "example.ts",
              type: "file",
              size: 6,
              mtime_ms: 1,
              hidden: false,
            },
          ],
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
    // Let the layout's resize RPC settle before emitting its matching frame.
    await new Promise((resolve) => setTimeout(resolve, 250));
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
  const requestAnnotation = (id: string, sourcePane = pane) =>
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_ANNOTATION_REQUEST_EVENT, {
        detail: {
          connectionId: client.connectionId,
          generation: 1,
          workspaceId: sourcePane.workspace_id,
          annotation: {
            id,
            source: "terminal",
            anchor: "quote",
            paneId: sourcePane.pane_id,
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
          generation: client.generation,
          workspaceId: pane.workspace_id,
          view: "files",
        },
      }),
    );
  try {
    flushSync(() =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    );
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
      check(
        !document.querySelector(".workspace-inspector"),
        "terminal annotation opened Inspector",
      );
      openInspector();
      check(
        !document.querySelector(".workspace-inspector"),
        "Inspector mounted before its independent request settled",
      );
      check(
        draft().length === 3,
        "successive saves were not persisted before Inspector mount/navigation",
      );
    });
    await until(
      () =>
        document.querySelector(".workspace-inspector") &&
        document.querySelectorAll(".annotation-card").length === 3,
      "annotations were overwritten by Inspector navigation",
    );
    check(
      document
        .querySelector(".workspace-inspector")
        ?.getAttribute("data-view") === "files",
      "Inspector view changed while opening Annotations",
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
      showAnnotations();
      type(".annotation-card:first-child textarea", "Edited without storage");
      click('button[aria-label="Close review feedback"]');
      toggleAnnotations();
      check(
        document.querySelector<HTMLTextAreaElement>(".annotation-card textarea")
          ?.value === "Edited without storage",
        "reopening reread stale stored comment over in-memory edit",
      );
      flushSync(() => requestAnnotation("memory-fallback-3"));
      check(
        document.querySelector<HTMLTextAreaElement>(".annotation-card textarea")
          ?.value === "Edited without storage",
        "new terminal save overwrote same-id in-memory edit",
      );
      click('button[aria-label="Delete comment 1"]');
      click('button[aria-label="Delete comment 3"]');
      click('button[aria-label="Close review feedback"]');
      toggleAnnotations();
      flushSync(() => requestAnnotation("memory-fallback-4"));
      check(
        document.querySelectorAll(".annotation-card").length === 3 &&
          !document.querySelector('[data-review-annotation-id="file-comment"]'),
        "reopen or new save resurrected a deleted stored comment",
      );
    } finally {
      roamgateLocalStorage.setItem = setItem;
    }
    click('button[aria-label="Close review feedback"]');
    click('button[aria-label="Close Workspace Inspector"]');
    await until(
      () => !document.querySelector(".annotation-panel"),
      "Annotations did not close before terminal selection",
    );
    // Start the selection fixture with one persisted file comment.
    flushSync(() => root.render(null));
    writeReviewAnnotations(roamgateLocalStorage, key, [file]);
    flushSync(() =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    );
    await until(
      () => document.querySelector(".xterm-screen"),
      "terminal remount missing",
    );
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
      !document.querySelector(".workspace-inspector"),
      "selection save opened Inspector",
    );
    paint();
    await settle();
    check(
      document.activeElement?.getAttribute("aria-label") === "Comment 2",
      "streaming terminal output stole annotation editing focus",
    );
    toggleAnnotations();
    check(
      !document.querySelector(".annotation-panel"),
      "toolbar did not close Annotations",
    );
    toggleAnnotations();
    check(
      document.querySelectorAll(".annotation-card").length === 2 &&
        !document.querySelector(".workspace-inspector"),
      "toolbar reopen lost draft or opened Inspector",
    );
    if (mobile()) click('button[aria-label="Show terminal session"]');
    await select();
    type(".annotation-composer-popover textarea", "Second selection");
    click('.annotation-composer-popover button[type="submit"]');
    await until(
      () => document.querySelectorAll(".annotation-card").length === 3,
      "repeat selection/save failed",
    );
    check(
      !document.querySelector(".workspace-inspector"),
      "repeat selection opened Inspector",
    );
    click('button[aria-label="Delete comment 3"]');

    check(
      document
        .querySelectorAll(".annotation-card")[1]
        ?.textContent?.includes("Terminal") === true,
      "source label missing",
    );
    openInspector();
    await until(
      () => document.querySelector(".workspace-inspector-slot"),
      "Inspector did not remain independently openable",
    );
    click(".workspace-inspector-tabs button:nth-child(2)");
    const inspectorBefore = document
      .querySelector(".workspace-inspector")!
      .getAttribute("data-view");
    flushSync(() => requestAnnotation("with-changes-open"));
    await settle();
    check(
      inspectorBefore === "changes" &&
        document
          .querySelector(".workspace-inspector")
          ?.getAttribute("data-view") === inspectorBefore &&
        !document.querySelector(".workspace-inspector-slot.is-closed"),
      "save changed or closed an already-open Inspector",
    );
    click('button[aria-label="Delete comment 3"]');
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      showAnnotations();
      await settle();
      const panel = document
        .querySelector(".annotation-panel")!
        .getBoundingClientRect();
      check(
        panel.width > 250 &&
          panel.right <= innerWidth + 1 &&
          panel.left >= 0 &&
          panel.bottom <= innerHeight + 1,
        `${theme}: annotation panel overflow`,
      );
      if (mobile()) {
        const surfaces = document
          .querySelector(".workspace-surfaces")!
          .getBoundingClientRect();
        check(
          Math.abs(panel.height - surfaces.height) <= 2,
          `${theme}: mobile Annotations does not fill active surface`,
        );
        check(
          !visible(".workspace-stage") && visible(".annotation-panel"),
          `${theme}: mobile surfaces overlap`,
        );
        const nav = document
          .querySelector('.mobile-nav[aria-label="Workspace view switcher"]')!
          .getBoundingClientRect();
        check(
          nav.top >= panel.bottom - 1 && !visible(".mobile-terminal-controls"),
          `${theme}: terminal controls or navigation cover draft`,
        );
        check(
          document
            .querySelector('button[aria-label="Show review annotations"]')!
            .getBoundingClientRect().height >= 44,
          `${theme}: Annotations navigation touch target too small`,
        );
        check(
          document
            .querySelector(".annotation-panel-head button")!
            .getBoundingClientRect().height >= 44,
          `${theme}: annotation close touch target too small`,
        );
        click('button[aria-label="Show workspace changes"]');
        check(
          !visible(".annotation-panel") && visible(".workspace-inspector"),
          "mobile Inspector did not replace Annotations surface",
        );
        click('button[aria-label="Show agent message history"]');
        await settle();
        showAnnotations();
        click('button[aria-label="Show agent message history"]');
        await settle();
        check(
          document
            .querySelector(".body")
            ?.classList.contains("mobile-view-history") === true &&
            visible(".workspace-inspector") &&
            !visible(".annotation-panel"),
          "mobile History navigation closed hidden Inspector instead of showing it",
        );
        click('button[aria-label="Show workspace changes"]');
        showAnnotations();
      } else {
        const resizer = document.querySelector<HTMLElement>(
          ".workspace-inspector-resizer",
        )!;
        const slot = document.querySelector<HTMLElement>(
          ".workspace-inspector-slot",
        )!;
        check(
          visible(".workspace-inspector-resizer"),
          "peer Inspector resize control missing",
        );
        const beforeResize = slot.getBoundingClientRect().width;
        flushSync(() =>
          resizer.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ArrowRight",
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await settle();
        const keyboardWidth = slot.getBoundingClientRect().width;
        check(
          keyboardWidth < beforeResize,
          "peer Inspector keyboard resize did not shrink panel",
        );
        const handle = resizer.getBoundingClientRect();
        flushSync(() =>
          resizer.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              clientX: handle.x,
              clientY: handle.y,
              button: 0,
            }),
          ),
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: handle.x - 12,
            clientY: handle.y,
          }),
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", {
            clientX: handle.x - 12,
            clientY: handle.y,
          }),
        );
        await settle();
        check(
          slot.getBoundingClientRect().width > keyboardWidth,
          "peer Inspector pointer resize did not grow panel",
        );
        const terminal = document
          .querySelector(".workspace-terminal-surface")!
          .getBoundingClientRect();
        const inspector = document
          .querySelector(".workspace-inspector-slot")!
          .getBoundingClientRect();
        const disjoint = (a: DOMRect, b: DOMRect) =>
          a.right <= b.left + 1 ||
          b.right <= a.left + 1 ||
          a.bottom <= b.top + 1 ||
          b.bottom <= a.top + 1;
        check(
          terminal.width >= 240 &&
            terminal.height >= 200 &&
            disjoint(panel, terminal) &&
            disjoint(panel, inspector) &&
            disjoint(terminal, inspector),
          `${theme}: peer surfaces cover each other or leave terminal unusable`,
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
    toggleAnnotations();
    toggleAnnotations();
    check(
      document
        .querySelector('button[aria-label="Agent pane"]')
        ?.textContent?.includes("Other agent") === true,
      "Annotations reopening reset explicit delivery destination",
    );
    click('button[aria-label="Close Workspace Inspector"]');
    flushSync(() => openInspector());
    await settle();
    showAnnotations();
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
    // Unloading the workspace owner invalidates its pending delivery session.
    flushSync(() => root.render(null));
    flushSync(() =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    );
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
    // A hidden Inspector may finish loading after another workspace owns Annotations.
    flushSync(() => openInspector());
    await until(
      () => document.querySelector('.file-row[data-file-path="example.ts"]'),
      "file fixture missing",
    );
    click('.file-row[data-file-path="example.ts"]');
    await until(() => previewDelivery, "old Inspector preview did not start");
    click('button[aria-label="Close Workspace Inspector"]');
    const original = store.get();
    const secondWorkspace: Workspace = {
      ...workspace,
      workspace_id: "second-review",
      label: "Second review",
      focused: false,
      active_tab_id: "second-tab",
      worktree: {
        ...workspace.worktree!,
        checkout_path: "/repo/second",
        is_linked_worktree: true,
      },
    };
    const secondPane: Pane = {
      ...pane,
      pane_id: "second-review-pane",
      terminal_id: "second-review-terminal",
      workspace_id: secondWorkspace.workspace_id,
      tab_id: "second-tab",
    };
    const secondKey = annotationDraftStorageKey(
      resourceScopeForWorkspace(client.connectionId, secondWorkspace),
    );
    writeReviewAnnotations(roamgateLocalStorage, secondKey, [
      { ...file, quote: "other();", comment: "Other checkout" },
    ]);
    const switchWorkspace = async (second: boolean) => {
      flushSync(() =>
        __storeTesting.replaceState({
          ...store.get(),
          workspaces: [
            { ...workspace, focused: !second },
            { ...secondWorkspace, focused: second },
          ],
          panes: [
            ...original.panes.map((item) => ({
              ...item,
              focused: !second && item.pane_id === pane.pane_id,
            })),
            { ...secondPane, focused: second },
          ],
          tabs: [
            ...original.tabs.map((item) => ({
              ...item,
              focused: !second && item.tab_id === pane.tab_id,
            })),
            {
              ...original.tabs[0],
              tab_id: secondPane.tab_id,
              workspace_id: secondWorkspace.workspace_id,
              focused: second,
            },
          ],
          selectedPaneId: second ? secondPane.pane_id : pane.pane_id,
          layout: null,
        }),
      );
      flushSync(() => store.clearNotice());
      await settle();
      showAnnotations();
      await settle();
    };
    await switchWorkspace(true);
    previewDelivery!.resolve({
      workspace_id: workspace.workspace_id,
      root: "/repo",
      checkout_path: "/repo",
      path: "example.ts",
      text: "run();",
      binary: false,
      size: 6,
      mtime_ms: 1,
      truncated: false,
    });
    previewDelivery = null;
    await until(
      () =>
        document
          .querySelector(".file-preview")
          ?.textContent?.includes("run();"),
      "hidden Inspector preview did not complete",
    );
    check(
      readReviewAnnotations(roamgateLocalStorage, secondKey)[0]?.stale !==
        true &&
        document.querySelector<HTMLTextAreaElement>(".annotation-card textarea")
          ?.value === "Other checkout",
      "old Inspector reanchored the active workspace's draft",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "scope delivery did not start");
    const retiredScopeDelivery = delivery!;
    delivery = null;
    await switchWorkspace(false);
    await switchWorkspace(true);
    check(
      !document.querySelector<HTMLButtonElement>(
        ".annotation-delivery-actions button:last-child",
      )!.disabled,
      "leaving a draft stranded delivery busy state",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "returned scope delivery did not start");
    retiredScopeDelivery.resolve({});
    await settle();
    check(
      readReviewAnnotations(roamgateLocalStorage, secondKey).length === 1 &&
        document.querySelector<HTMLButtonElement>(
          ".annotation-delivery-actions button:last-child",
        )!.disabled,
      "old delivery cleared returned draft or reset its newer delivery",
    );
    delivery!.reject(new Error("Keep returned draft"));
    delivery = null;
    await settle();
    const restoreStorage = roamgateLocalStorage.setItem;
    try {
      roamgateLocalStorage.setItem = (storageKey, value) => {
        if (storageKey === secondKey) throw new Error("Storage unavailable");
        restoreStorage(storageKey, value);
      };
      type(".annotation-card textarea", "Unsaved scope edit");
      await switchWorkspace(false);
      await switchWorkspace(true);
      check(
        document.querySelector<HTMLTextAreaElement>(".annotation-card textarea")
          ?.value === "Unsaved scope edit",
        "scope switching lost unsaved edit",
      );
      click('button[aria-label="Delete comment 1"]');
      await switchWorkspace(false);
      await switchWorkspace(true);
      flushSync(() => requestAnnotation("after-unsaved-delete", secondPane));
      check(
        document.querySelectorAll(".annotation-card").length === 1 &&
          !document.querySelector('[data-review-annotation-id="file-comment"]'),
        "scope switching/new save resurrected unsaved delete",
      );
    } finally {
      roamgateLocalStorage.setItem = restoreStorage;
    }
    await switchWorkspace(false);
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "old generation delivery missing");
    client = {
      ...client,
      generation: 2,
      isCurrent: () => store.get().connectionGeneration === 2,
    };
    flushSync(() => {
      __storeTesting.replaceState({ ...store.get(), connectionGeneration: 2 });
      store.clearNotice();
    });
    await settle();
    showAnnotations();
    delivery!.resolve({});
    delivery = null;
    await settle();
    check(
      draft().length === 2 &&
        document.querySelectorAll(".annotation-card").length === 2,
      "old connection generation cleared the current draft",
    );
    check(
      !document.querySelector<HTMLButtonElement>(
        ".annotation-delivery-actions button:last-child",
      )!.disabled,
      "connection generation change stranded delivery busy state",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "last workspace delivery missing");
    const beforeRemoval = draft();
    const beforeRemovalSnapshot = store.get();
    flushSync(() => {
      __storeTesting.replaceState({
        ...beforeRemovalSnapshot,
        workspaces: [],
        panes: [],
        tabs: [],
        layout: null,
      });
      store.clearNotice();
    });
    await settle();
    check(
      !document.querySelector(".annotation-panel"),
      "removed workspace kept its Annotations surface active",
    );
    delivery!.resolve({});
    delivery = null;
    await settle();
    check(
      JSON.stringify(draft()) === JSON.stringify(beforeRemoval),
      "last workspace removal let delayed pre-fill clear its draft",
    );
    flushSync(() => {
      __storeTesting.replaceState(beforeRemovalSnapshot);
      store.clearNotice();
    });
    await settle();
    showAnnotations();
    check(
      !document.querySelector<HTMLButtonElement>(
        ".annotation-delivery-actions button:last-child",
      )!.disabled,
      "restored workspace retained stale delivery busy state",
    );
    const sharedWorkspace: Workspace = {
      ...workspace,
      workspace_id: "shared-checkout",
      active_tab_id: "shared-tab",
    };
    const sharedPane: Pane = {
      ...pane,
      pane_id: "shared-pane",
      terminal_id: "shared-terminal",
      workspace_id: sharedWorkspace.workspace_id,
      tab_id: "shared-tab",
      agent: "Shared checkout agent",
    };
    const beforeShared = store.get();
    check(
      annotationDraftStorageKey(
        resourceScopeForWorkspace(client.connectionId, sharedWorkspace),
      ) === key,
      "shared checkout fixture does not share its draft key",
    );
    const focusShared = async (shared: boolean) => {
      flushSync(() => {
        __storeTesting.replaceState({
          ...beforeShared,
          workspaces: [
            { ...workspace, focused: !shared },
            { ...sharedWorkspace, focused: shared },
          ],
          panes: [
            ...beforeShared.panes.map((item) => ({
              ...item,
              focused: !shared && item.pane_id === pane.pane_id,
            })),
            { ...sharedPane, focused: shared },
          ],
          tabs: [
            ...beforeShared.tabs.map((item) => ({
              ...item,
              focused: !shared && item.tab_id === pane.tab_id,
            })),
            {
              ...beforeShared.tabs[0],
              workspace_id: sharedWorkspace.workspace_id,
              tab_id: sharedPane.tab_id,
              focused: shared,
            },
          ],
          selectedPaneId: shared ? sharedPane.pane_id : pane.pane_id,
          layout: null,
        });
        store.clearNotice();
      });
      await settle();
    };
    flushSync(() => openInspector());
    await settle();
    showAnnotations();
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "shared checkout original delivery missing");
    const sharedOldDelivery = delivery!;
    delivery = null;
    await focusShared(true);
    check(
      document.querySelectorAll(".annotation-card").length === 2,
      "shared checkout route switch lost or closed shared draft",
    );
    check(
      document
        .querySelector(".annotation-target-summary")
        ?.textContent?.includes("Shared checkout agent") === true,
      "shared checkout switch still targets previous workspace agents",
    );
    check(
      !draft().some((item) => item.stale),
      "shared checkout switch marked available source panes stale",
    );
    check(
      !document.querySelector<HTMLButtonElement>(
        ".annotation-delivery-actions button:last-child",
      )!.disabled,
      "shared checkout route switch kept old delivery busy",
    );
    click(".annotation-delivery-actions button:last-child");
    await until(() => delivery, "shared checkout destination delivery missing");
    check(
      sent[sent.length - 1]?.pane_id === sharedPane.pane_id,
      "shared checkout feedback was sent to previous workspace",
    );
    sharedOldDelivery.resolve({});
    await settle();
    check(
      draft().length === 2 &&
        document.querySelector<HTMLButtonElement>(
          ".annotation-delivery-actions button:last-child",
        )!.disabled,
      "old workspace delivery cleared shared draft or newer delivery state",
    );
    delivery!.reject(new Error("Retain shared checkout draft"));
    delivery = null;
    await settle();
    click('button[aria-label="Close Workspace Inspector"]');
    await focusShared(false);
    check(
      document.querySelectorAll(".annotation-card").length === 2 &&
        document
          .querySelector('button[aria-label="Agent pane"]')
          ?.textContent?.includes("Shared checkout agent") !== true,
      "closed Inspector prevented annotation route from returning to original workspace",
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
      new CustomEvent(WORKSPACE_ANNOTATION_REQUEST_EVENT, {
        detail: {
          connectionId: client.connectionId,
          generation: 0,
          workspaceId: pane.workspace_id,
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
