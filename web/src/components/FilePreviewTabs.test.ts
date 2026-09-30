import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FilePreviewTabs } from "./FilePreviewTabs";
import { AnnotationComposerPopover } from "./AnnotationComposerPopover";
import {
  closeResourceFileTab,
  type ResourceFileTabs,
} from "../workspaceResource";

// Keep browser globals out of Bun's shared module graph and unrelated tests.
if (process.env.ROAMGATE_FILE_TABS_DOM_TEST === "1") {
  registerDomTests();
} else {
  test("file preview DOM regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_FILE_TABS_DOM_TEST: "1" },
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
}

function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let root: Root;
  let container: HTMLDivElement;

  beforeAll(() => {
    const replacements: Record<string, unknown> = {
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      ResizeObserver: browser.ResizeObserver,
      MutationObserver: browser.MutationObserver,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(replacements)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true,
      });
    }
  });
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  });

  async function mount(element: ReturnType<typeof createElement>) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(element));
  }
  function key(target: Element, value: string) {
    target.dispatchEvent(
      new browser.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
      }) as unknown as KeyboardEvent,
    );
  }
  function tab(path: string) {
    return container.querySelector<HTMLButtonElement>(
      `[role="tab"][aria-label="${path}"]`,
    )!;
  }
  function Harness({
    onEmptyFocus = () => {},
    previewPath = null,
  }: {
    onEmptyFocus?: () => void;
    previewPath?: string | null;
  }) {
    const [tabs, setTabs] = useState<ResourceFileTabs>({
      paths: ["src/index.ts", "test/index.ts", "README.md"],
      activePath: "src/index.ts",
      previewPath,
    });
    return createElement(FilePreviewTabs, {
      tabs,
      panelId: "preview",
      onSelect: (activePath) =>
        setTabs((current) => ({ ...current, activePath })),
      onPin: (path) =>
        setTabs((current) =>
          current.previewPath === path
            ? { ...current, previewPath: null }
            : current,
        ),
      onClose: (path) =>
        setTabs((current) => closeResourceFileTab(current, path)),
      onEmptyFocus,
    });
  }

  describe("file preview tab interactions", () => {
    test("double-click or Enter keeps a temporary preview open", async () => {
      await mount(createElement(Harness, { previewPath: "src/index.ts" }));
      expect(
        tab("src/index.ts").closest(".file-preview-tab")?.className,
      ).toContain("is-preview");
      await act(async () =>
        tab("src/index.ts").dispatchEvent(
          new browser.MouseEvent("dblclick", {
            bubbles: true,
          }) as unknown as MouseEvent,
        ),
      );
      expect(
        tab("src/index.ts").closest(".file-preview-tab")?.className,
      ).not.toContain("is-preview");
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () =>
        root.render(createElement(Harness, { previewPath: "src/index.ts" })),
      );
      await act(async () => key(tab("src/index.ts"), "Enter"));
      expect(
        tab("src/index.ts").closest(".file-preview-tab")?.className,
      ).not.toContain("is-preview");
    });

    test("disambiguates paths, exposes selection and supports roving keyboard navigation", async () => {
      await mount(createElement(Harness));
      expect(container.textContent).toContain("src");
      expect(container.textContent).toContain("test");
      expect(tab("src/index.ts").tabIndex).toBe(0);
      expect(tab("test/index.ts").tabIndex).toBe(-1);
      await act(async () => key(tab("src/index.ts"), "ArrowRight"));
      expect(tab("test/index.ts").getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tab("test/index.ts"));
      await act(async () => key(tab("test/index.ts"), "End"));
      expect(document.activeElement).toBe(tab("README.md"));
      await act(async () => key(tab("README.md"), "Home"));
      expect(document.activeElement).toBe(tab("src/index.ts"));
      await act(async () => key(tab("src/index.ts"), "ArrowLeft"));
      expect(document.activeElement).toBe(tab("README.md"));
    });

    test("button and middle-click close inactive files without changing selection", async () => {
      await mount(createElement(Harness));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Close test/index.ts"]',
          )!
          .click(),
      );
      expect(tab("test/index.ts")).toBeNull();
      expect(tab("src/index.ts").getAttribute("aria-selected")).toBe("true");
      await act(async () =>
        tab("README.md").dispatchEvent(
          new browser.MouseEvent("auxclick", {
            button: 1,
            bubbles: true,
          }) as unknown as MouseEvent,
        ),
      );
      expect(tab("README.md")).toBeNull();
      expect(tab("src/index.ts").getAttribute("aria-selected")).toBe("true");
    });

    test("Delete selects a neighbor and last close returns focus to navigation", async () => {
      let emptyFocus = 0;
      await mount(
        createElement(Harness, {
          onEmptyFocus: () => {
            emptyFocus += 1;
          },
        }),
      );
      await act(async () => key(tab("src/index.ts"), "Delete"));
      expect(document.activeElement).toBe(tab("test/index.ts"));
      await act(async () => key(tab("test/index.ts"), "Delete"));
      expect(document.activeElement).toBe(tab("README.md"));
      await act(async () => key(tab("README.md"), "Delete"));
      await browser.happyDOM.whenAsyncComplete();
      expect(container.querySelector('[role="tablist"]')).toBeNull();
      expect(emptyFocus).toBe(1);
    });

    test("tab pointer capture suspends a controlled draft and restores its text", async () => {
      let closed = 0;
      const draft = {
        x: 10,
        y: 10,
        title: "src/index.ts",
        quote: "const value = 1;",
      };
      const render = (visible: boolean) =>
        createElement(
          "div",
          null,
          createElement(
            "button",
            { "data-file-preview-tab": "" },
            "Other file",
          ),
          createElement(AnnotationComposerPopover, {
            draft: visible ? draft : null,
            commentValue: "Keep this comment",
            onCommentChange: () => {},
            suspendOnFileTabNavigation: true,
            onSave: () => {},
            onClose: () => {
              closed += 1;
            },
          }),
        );
      await mount(render(true));
      const otherTab = container.querySelector("button")!;
      await act(async () =>
        otherTab.dispatchEvent(
          new browser.PointerEvent("pointerdown", {
            bubbles: true,
          }) as unknown as PointerEvent,
        ),
      );
      expect(closed).toBe(0);
      await act(async () => root.render(render(false)));
      expect(document.querySelector("textarea")).toBeNull();
      await act(async () => root.render(render(true)));
      expect(document.querySelector("textarea")?.value).toBe(
        "Keep this comment",
      );
      await act(async () =>
        document.body.dispatchEvent(
          new browser.PointerEvent("pointerdown", {
            bubbles: true,
          }) as unknown as PointerEvent,
        ),
      );
      expect(closed).toBe(1);
    });
  });

  test("Inspector restores Files and preserves a newer selection during deletion", async () => {
    let deleteFixture = () => {};
    mock.module("./FileExplorerDialog", () => ({
      FileExplorerPanel: ({
        onPreviewChange,
      }: Parameters<
        typeof import("./FileExplorerDialog").FileExplorerPanel
      >[0]) => {
        deleteFixture = () =>
          onPreviewChange?.(
            { entry: null, preview: null, loading: false, error: null },
            { deletedEntry: { path: "a.ts", type: "file" } },
          );
        return createElement(
          "button",
          {
            onClick: deleteFixture,
          },
          "Delete fixture a.ts",
        );
      },
    }));
    const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
    const { roamgateLocalStorage } = await import("../browserStorage");
    const {
      readResourceFileTabs,
      writeResourceFileTabs,
      writeResourceFileSelection,
    } = await import("../workspaceResource");
    const scope = {
      kind: "workspace" as const,
      connectionId: "legacy-default",
      workspaceId: "tabs-test",
    };
    writeResourceFileTabs(roamgateLocalStorage, scope, {
      paths: ["a.ts", "b.ts"],
      activePath: "a.ts",
      previewPath: null,
    });
    const request = { current: 4 };
    const selections: string[] = [];
    function InspectorHarness({
      initialDirectory,
    }: {
      initialDirectory?: string;
    }) {
      const [view, setView] = useState<"files" | "changes">(
        initialDirectory === undefined ? "changes" : "files",
      );
      const [selection, setSelection] = useState<
        import("./FilePreviewContent").ActiveFilePreviewSelection
      >({ entry: null, preview: null, loading: false, error: null });
      return createElement(WorkspaceInspectorHost, {
        state: {
          scope,
          initialDirectory,
          open: true,
          view,
          dock: "right",
          size: 520,
          expanded: false,
        },
        visible: false,
        workspace: {
          workspace_id: "tabs-test",
          number: 1,
          label: "Test",
          focused: false,
          pane_count: 0,
          tab_count: 0,
          agent_status: "unknown",
        },
        fileSelection: selection,
        previewRequestRef: request,
        diffSelection: {
          entry: null,
          file: null,
          loading: false,
          error: null,
          entries: [],
          files: {},
          fileErrors: {},
          summaryLoading: false,
        },
        connectionClient: {
          connectionId: "legacy-default",
          generation: 1,
          serverRuntimeGeneration: null,
          isCurrent: () => false,
          acceptsServerGeneration: () => false,
          call: async () => null,
        },
        onSelectFileTab: (path) => {
          selections.push(path);
          request.current += 1;
          writeResourceFileSelection(roamgateLocalStorage, scope, path);
          setSelection({
            entry: {
              path,
              name: path,
              type: "file",
              size: 0,
              mtime_ms: 0,
              hidden: false,
            },
            preview: null,
            loading: true,
            error: null,
          });
        },
        onFileSelectionChange: setSelection,
        onViewChange: (next) => setView(next === "files" ? "files" : "changes"),
        onDiffSelectionChange: () => {},
        onOpenDocument: () => {},
        onRefreshFile: () => {},
        onOpenDiffFile: () => {},
        annotations: [],
        onCreateAnnotation: () => {},
        onReanchorFileAnnotations: () => {},
        onReanchorDiffAnnotations: () => {},
        onEditAnnotation: () => {},
        onDockChange: () => {},
        onExpandedChange: () => {},
        onClose: () => {},
        onBack: () => {},
      });
    }
    await mount(createElement(InspectorHarness, {}));
    expect(selections).toEqual([]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '.workspace-inspector-tabs [role="tab"]',
        )!
        .click(),
    );
    expect(selections).toEqual(["a.ts"]);
    const pendingDelete = deleteFixture;
    await act(async () => key(tab("a.ts"), "ArrowRight"));
    const pendingRequest = request.current;
    await act(async () => pendingDelete());
    expect(request.current).toBe(pendingRequest);
    expect(selections).toEqual(["a.ts", "b.ts"]);
    expect(readResourceFileTabs(roamgateLocalStorage, scope)).toEqual({
      paths: ["b.ts"],
      activePath: "b.ts",
      previewPath: null,
    });
    await act(async () => key(tab("b.ts"), "Delete"));
    expect(request.current).toBeGreaterThan(pendingRequest);
    expect(readResourceFileTabs(roamgateLocalStorage, scope)).toEqual({
      paths: [],
      activePath: null,
      previewPath: null,
    });
    expect(selections).toEqual(["a.ts", "b.ts"]);
    writeResourceFileTabs(roamgateLocalStorage, scope, {
      paths: ["a.ts"],
      activePath: "a.ts",
      previewPath: null,
    });
    await act(async () =>
      root.render(
        createElement(InspectorHarness, {
          key: "directory",
          initialDirectory: "src",
        }),
      ),
    );
    expect(tab("a.ts").getAttribute("aria-selected")).toBe("true");
    expect(
      container
        .querySelector(".workspace-inspector")
        ?.classList.contains("has-detail"),
    ).toBe(false);
  });
}
