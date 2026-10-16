import { expect, spyOn, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import {
  createLocalDirectory,
  listLocalFiles,
  moveLocalFile,
  readLocalFile,
} from "../../../server/src/workspace/local-files";
import { bridge, type ConnectionClient } from "../api";
import { __storeTesting, store } from "../store";
import { WORKSPACE_PATH_DRAG_TYPE } from "../workspacePathDrag";
import { requestFilePreview } from "./fileExplorerResources";

if (process.env.ROAMGATE_FILE_EXPLORER_DOM_TEST !== "1") {
  test("file explorer interactions with real file handlers in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_FILE_EXPLORER_DOM_TEST: "1" },
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
  // Real filesystem and DOM work needs headroom under parallel suite load.
  test("creates folders, selects files, moves batches and preserves failed selections", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      HTMLInputElement: browser.HTMLInputElement,
      MutationObserver: browser.MutationObserver,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
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
    const { FileExplorerPanel, FileExplorerDialog } = await import(
      "./FileExplorerDialog"
    );
    const directory = await mkdtemp(join(tmpdir(), "roamgate-files-dom-"));
    for (const name of ["a.txt", "b.txt", "c.txt"])
      await writeFile(join(directory, name), name);
    const previous = store.get();
    const pending = new Set<Promise<unknown>>();
    let activeMoves = 0;
    let peakMoves = 0;
    let mkdirDelay: Promise<void> | undefined;
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const client: ConnectionClient = {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call(method, params = {}) {
        calls.push({ method, params });
        const handlers: Record<
          string,
          (params: Record<string, unknown>) => Promise<unknown>
        > = {
          "file.list": async (params) => ({
            ...(await listLocalFiles(
              directory,
              String(params.path ?? ""),
              false,
            )),
            workspace_id: "w1",
            checkout_path: directory,
          }),
          "file.read": (params) =>
            readLocalFile(directory, String(params.path)),
          "file.mkdir": async (params) => {
            await mkdirDelay;
            return createLocalDirectory(
              directory,
              String(params.directory),
              String(params.name),
            );
          },
          "file.move": (params) =>
            moveLocalFile(
              directory,
              String(params.path),
              String(params.directory),
            ),
          "git.diff_summary": async () => ({ entries: [], counts: {} }),
        };
        const task = handlers[method]!(params);
        if (method === "file.move")
          peakMoves = Math.max(peakMoves, ++activeMoves);
        pending.add(task);
        void task.then(
          () => {
            pending.delete(task);
            if (method === "file.move") activeMoves -= 1;
          },
          () => {
            pending.delete(task);
            if (method === "file.move") activeMoves -= 1;
          },
        );
        return task;
      },
    };
    const connection = spyOn(bridge, "connection").mockReturnValue(client);
    const notify = spyOn(store, "notify");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    async function update(action: () => void) {
      await act(async () => {
        action();
      });
      await act(async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      });
    }
    async function setFolderName(name: string) {
      await update(() => {
        const input = container.querySelector<HTMLInputElement>(
          "[role='dialog'][aria-label='New folder'] input",
        )!;
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, name);
        input.dispatchEvent(
          new browser.Event("input", { bubbles: true }) as unknown as Event,
        );
      });
    }
    function submitFolder() {
      container.querySelector("form")!.dispatchEvent(
        new browser.Event("submit", {
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      );
    }
    async function submitFolderName(name: string) {
      await setFolderName(name);
      await update(submitFolder);
    }
    function row(path: string) {
      const element = [
        ...container.querySelectorAll<HTMLElement>(".file-row[data-file-path]"),
      ].find((element) => element.dataset.filePath === path);
      if (!element) throw new Error(`Missing row ${path}`);
      return element;
    }
    const click = (
      element: Element,
      options: {
        ctrlKey?: boolean;
        shiftKey?: boolean;
        metaKey?: boolean;
      } = {},
    ) =>
      element.dispatchEvent(
        new browser.MouseEvent("click", {
          bubbles: true,
          ...options,
        }) as unknown as Event,
      );
    function selected() {
      return [
        ...container.querySelectorAll<HTMLElement>("[aria-selected='true']"),
      ].map((row) => row.dataset.filePath);
    }
    function contextMenu(element: Element) {
      const event = new browser.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event as unknown as Event);
      return event.defaultPrevented;
    }
    const menuLabels = () =>
      [...container.querySelectorAll("[role='menuitem']")].map(
        (item) => item.textContent,
      );
    function dragStart(path: string) {
      const values = new Map<string, string>();
      const transfer = {
        effectAllowed: "none",
        dropEffect: "none",
        types: [] as string[],
        getData: (type: string) => values.get(type) ?? "",
        setData(type: string, value: string) {
          values.set(type, value);
          this.types = [...values.keys()];
        },
      };
      row(path).dispatchEvent(
        new browser.PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
        }) as unknown as Event,
      );
      drag(row(path), "dragstart", transfer);
      return transfer;
    }
    function drag(element: Element, type: string, transfer: unknown) {
      const event = new browser.Event(type, {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      element.dispatchEvent(event as unknown as Event);
      return event;
    }
    try {
      __storeTesting.replaceState({
        ...previous,
        activeConnectionId: "local",
        workspaces: [
          {
            workspace_id: "w1",
            number: 1,
            label: "Files test",
            focused: true,
            pane_count: 0,
            tab_count: 0,
            agent_status: "idle",
            cwd: directory,
          },
        ],
      });
      await update(() =>
        root.render(
          createElement(FileExplorerPanel, {
            open: true,
            workspaceId: "w1",
            onClose: () => {},
          }),
        ),
      );
      expect(
        container
          .querySelector("[role='tree']")
          ?.getAttribute("aria-multiselectable"),
      ).toBe("true");
      await update(() =>
        click(container.querySelector("[aria-label='New folder']")!),
      );
      await setFolderName("target");
      const creation = Promise.withResolvers<void>();
      mkdirDelay = creation.promise;
      try {
        await act(async () => {
          submitFolder();
          submitFolder();
        });
        expect(
          calls.filter((call) => call.method === "file.mkdir"),
        ).toHaveLength(1);
        expect(
          container.querySelector<HTMLButtonElement>("button[type='submit']")!
            .disabled,
        ).toBe(true);
        expect(
          container.querySelector<HTMLInputElement>("[role='dialog'] input")!
            .disabled,
        ).toBe(true);
        await act(async () => submitFolder());
        expect(
          calls.filter((call) => call.method === "file.mkdir"),
        ).toHaveLength(1);
      } finally {
        await update(() => creation.resolve());
        mkdirDelay = undefined;
      }
      expect(await readdir(directory)).toContain("target");
      expect(row("target")).toBeDefined();
      expect(
        notify.mock.calls.map(([notification]) => notification.kind),
      ).toEqual(["success"]);
      expect(container.querySelector("form")).toBeNull();
      await update(() =>
        click(container.querySelector("[aria-label='New folder']")!),
      );
      await submitFolderName("target");
      expect(
        notify.mock.calls[notify.mock.calls.length - 1]?.[0],
      ).toMatchObject({
        kind: "error",
        message: "Create folder failed",
      });
      expect(
        container.querySelector<HTMLInputElement>("[role='dialog'] input")!
          .value,
      ).toBe("target");
      expect(
        container.querySelector<HTMLInputElement>("[role='dialog'] input")!
          .disabled,
      ).toBe(false);
      expect(
        container.querySelector<HTMLButtonElement>("button[type='submit']")!
          .disabled,
      ).toBe(false);
      await submitFolderName("retry-folder");
      expect(await readdir(directory)).toContain("retry-folder");
      expect(container.querySelector("form")).toBeNull();
      await update(() =>
        row("target").dispatchEvent(
          new browser.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
          }) as unknown as Event,
        ),
      );
      await update(() =>
        click(
          [...container.querySelectorAll("[role='menuitem']")].find(
            (item) => item.textContent === "New folder",
          )!,
        ),
      );
      await submitFolderName("nested");
      expect(await readdir(join(directory, "target"))).toContain("nested");
      await update(() => {
        expect(
          contextMenu(container.querySelector(".file-explorer-browser")!),
        ).toBe(true);
      });
      expect(menuLabels()).toEqual(["New folder", "Refresh files"]);
      await update(() => click(container.querySelector("[role='menuitem']")!));
      await submitFolderName("background-folder");
      expect(await readdir(directory)).toContain("background-folder");
      expect(
        calls.filter((call) => call.method === "file.mkdir").pop()?.params,
      ).toMatchObject({ directory: "", name: "background-folder" });
      await update(() => {
        contextMenu(row("a.txt"));
      });
      expect(menuLabels()).toContain("Download file");
      expect(menuLabels()).not.toContain("New folder");
      expect(menuLabels()).not.toContain("Refresh files");
      await update(() => {
        contextMenu(container.querySelector(".file-tree")!);
      });
      expect(menuLabels()).toEqual(["New folder", "Refresh files"]);
      const listingsBeforeRefresh = calls.filter(
        (call) => call.method === "file.list",
      ).length;
      await update(() =>
        click([...container.querySelectorAll("[role='menuitem']")][1]),
      );
      expect(
        calls.filter((call) => call.method === "file.list").length,
      ).toBeGreaterThan(listingsBeforeRefresh);
      expect(menuLabels()).toEqual([]);
      await update(() => {
        expect(
          contextMenu(
            container.querySelector("[aria-label='Search checkout']")!,
          ),
        ).toBe(false);
      });
      expect(menuLabels()).toEqual([]);
      await update(() => click(row("a.txt")));
      await update(() => click(row("c.txt"), { shiftKey: true }));
      expect(selected()).toEqual(["a.txt", "b.txt", "c.txt"]);
      await update(() => click(row("b.txt"), { metaKey: true }));
      expect(selected()).toEqual(["a.txt", "c.txt"]);
      await writeFile(join(directory, "target/c.txt"), "keep");
      await writeFile(join(directory, "target/a.txt"), "old target preview");
      await requestFilePreview("w1", "target/a.txt", { client });
      await rm(join(directory, "target/a.txt"));
      let transfer!: ReturnType<typeof dragStart>;
      await update(() => {
        transfer = dragStart("a.txt");
      });
      expect(transfer.getData(WORKSPACE_PATH_DRAG_TYPE)).toBe(
        `${await realpath(directory)}/a.txt`,
      );
      expect(transfer.effectAllowed).toBe("copyMove");
      await update(() => {
        expect(drag(row("b.txt"), "dragover", transfer).defaultPrevented).toBe(
          false,
        );
      });
      await update(() => {
        expect(drag(row("target"), "dragover", transfer).defaultPrevented).toBe(
          true,
        );
      });
      expect(transfer.dropEffect).toBe("move");
      await update(() => {
        drag(row("target"), "drop", transfer);
      });
      expect(
        calls
          .filter((call) => call.method === "file.move")
          .map((call) => call.params.path),
      ).toEqual(["a.txt", "c.txt"]);
      expect(peakMoves).toBe(1);
      expect(await readFile(join(directory, "target/a.txt"), "utf8")).toBe(
        "a.txt",
      );
      expect(await readFile(join(directory, "target/c.txt"), "utf8")).toBe(
        "keep",
      );
      expect(selected()).toEqual(["c.txt"]);
      expect(
        await requestFilePreview("w1", "target/a.txt", { client }),
      ).toMatchObject({ text: "a.txt" });
      expect(
        notify.mock.calls[notify.mock.calls.length - 1]?.[0],
      ).toMatchObject({
        kind: "error",
        detail: expect.stringContaining("1 of 2 moved"),
      });
      await update(() => {
        transfer = dragStart("b.txt");
        drag(row("target"), "drop", transfer);
      });
      expect(await readFile(join(directory, "target/b.txt"), "utf8")).toBe(
        "b.txt",
      );
      expect(row("target/a.txt")).toBeDefined();
      await update(() => {
        transfer = dragStart("target/a.txt");
        drag(container.querySelector(".file-tree")!, "drop", transfer);
      });
      expect(await readFile(join(directory, "a.txt"), "utf8")).toBe("a.txt");
      await update(() =>
        row("a.txt").dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "a",
            ctrlKey: true,
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      expect(selected()).toEqual([
        "target/b.txt",
        "target/c.txt",
        "a.txt",
        "c.txt",
      ]);
      const batch = Array.from(
        { length: 30 },
        (_, index) => `batch-${String(index).padStart(2, "0")}.txt`,
      );
      for (const path of batch) await writeFile(join(directory, path), path);
      await update(() =>
        click(container.querySelector("[aria-label='Refresh files']")!),
      );
      await update(() => click(row(batch[0])));
      await update(() =>
        click(row(batch[batch.length - 1]), { shiftKey: true }),
      );
      expect(selected()).toEqual(batch);
      await update(() => {
        transfer = dragStart(batch[0]);
        drag(row("target"), "drop", transfer);
      });
      expect(peakMoves).toBe(1);
      for (const path of batch)
        expect(await readFile(join(directory, "target", path), "utf8")).toBe(
          path,
        );
      await update(() => click(row("a.txt"), { shiftKey: true }));
      expect(selected()).toEqual(["a.txt"]);
      await update(() => click(row("c.txt"), { shiftKey: true }));
      expect(selected()).toEqual(["a.txt", "c.txt"]);
      await update(() => {
        transfer = dragStart("a.txt");
      });
      const movesBeforeSwitch = calls.filter(
        (call) => call.method === "file.move",
      ).length;
      await update(() => {
        const state = store.get();
        __storeTesting.replaceState({
          ...state,
          workspaces: state.workspaces.map((workspace) => ({
            ...workspace,
            workspace_id: "w2",
          })),
        });
        root.render(
          createElement(FileExplorerPanel, {
            open: true,
            workspaceId: "w2",
            onClose: () => {},
          }),
        );
      });
      await update(() => {
        drag(row("target"), "drop", transfer);
      });
      expect(calls.filter((call) => call.method === "file.move")).toHaveLength(
        movesBeforeSwitch,
      );
      await update(() =>
        click(container.querySelector("[aria-label='Browse filesystem']")!),
      );
      expect(container.querySelector("[aria-label='New folder']")).toBeNull();
      await update(() => {
        expect(
          contextMenu(container.querySelector(".file-explorer-browser")!),
        ).toBe(false);
      });
      expect(menuLabels()).toEqual([]);
      let closes = 0;
      await update(() =>
        root.render(
          createElement(FileExplorerDialog, {
            open: true,
            workspaceId: "w2",
            onClose: () => {
              closes += 1;
            },
          }),
        ),
      );
      await update(() => {
        contextMenu(container.querySelector(".file-explorer-browser")!);
      });
      // Allow the menu to attach its deferred keyboard listener and focus its first action.
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      const actions = [
        ...container.querySelectorAll<HTMLElement>("[role='menuitem']"),
      ];
      expect(document.activeElement).toBe(actions[0]);
      await update(() =>
        actions[0].dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      expect(document.activeElement).toBe(actions[1]);
      await update(() =>
        actions[1].dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      expect(closes).toBe(0);
      expect(menuLabels()).toEqual([]);
      await update(() => click(row("a.txt")));
      await update(() => click(row("c.txt"), { metaKey: true }));
      expect(selected()).toEqual(["a.txt", "c.txt"]);
      const clearSelection = new browser.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      await update(() =>
        row("c.txt").dispatchEvent(clearSelection as unknown as Event),
      );
      expect(closes).toBe(0);
      expect(selected()).toEqual([]);
      expect(clearSelection.defaultPrevented).toBe(true);
      await update(() =>
        click(container.querySelector("button[aria-label='New folder']")!),
      );
      await update(() =>
        container
          .querySelector("[aria-label='New folder'] input")!
          .dispatchEvent(
            new browser.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }) as unknown as Event,
          ),
      );
      expect(closes).toBe(0);
      expect(
        container.querySelector("[role='dialog'][aria-label='New folder']"),
      ).toBeNull();
      expect(
        container.querySelector("[role='dialog'][aria-label='File Explorer']"),
      ).not.toBeNull();
      await update(() =>
        click(container.querySelector("button[aria-label='New folder']")!),
      );
      await setFolderName("pending-folder");
      const pendingCreation = Promise.withResolvers<void>();
      mkdirDelay = pendingCreation.promise;
      try {
        await act(async () => submitFolder());
        const input = container.querySelector<HTMLInputElement>(
          "[aria-label='New folder'] input",
        )!;
        expect(input.disabled).toBe(true);
        // Model browser focus loss when the focused input becomes disabled.
        document.body.focus();
        expect(document.activeElement === document.body).toBe(true);
        await act(async () =>
          document.body.dispatchEvent(
            new browser.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }) as unknown as Event,
          ),
        );
        expect(closes).toBe(0);
        expect(
          container.querySelector("[role='dialog'][aria-label='New folder']"),
        ).toBeNull();
        expect(
          container.querySelector(
            "[role='dialog'][aria-label='File Explorer']",
          ),
        ).not.toBeNull();
      } finally {
        await update(() => pendingCreation.resolve());
        mkdirDelay = undefined;
      }
      expect(await readdir(directory)).toContain("pending-folder");
      await update(() =>
        document.body.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      expect(closes).toBe(1);
    } finally {
      await act(async () => root.unmount());
      connection.mockRestore();
      notify.mockRestore();
      __storeTesting.replaceState(previous);
      container.remove();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
}
