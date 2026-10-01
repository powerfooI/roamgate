import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { store } from "../store";
import { terminalFocusBlockedByOverlay } from "../terminalFocus";
import type { PaneLayout } from "../types";
import { PaneDragHandle, PaneMoveMenu } from "./PaneMoveMenu";

// DOM globals must not leak into the other store and terminal tests.
if (process.env.ROAMGATE_PANE_MOVE_DOM_TEST === "1") {
  registerDomTests();
} else {
  test("pane swap drag regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PANE_MOVE_DOM_TEST: "1" },
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
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const layout: PaneLayout = {
    workspace_id: "workspace",
    tab_id: "tab",
    zoomed: false,
    area: { x: 0, y: 0, width: 150, height: 30 },
    focused_pane_id: "a",
    splits: [],
    panes: ["a", "b", "c"].map((pane_id, i) => ({
      pane_id,
      focused: i === 0,
      rect: { x: i * 50, y: 0, width: 50, height: 30 },
    })),
  };
  let snapshot: ReturnType<typeof store.get>;
  let root: Root;
  let grid: HTMLDivElement;
  let button: HTMLButtonElement;
  let menuButton: HTMLButtonElement;
  let target: HTMLDivElement;
  let hit: Element | null;
  let swaps: Array<[string, string]>;
  let restore: Array<() => void>;

  beforeAll(() => {
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    }
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    grid?.remove();
    for (const cleanup of restore.reverse()) cleanup();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function mount() {
    snapshot = { ...store.get(), layout };
    swaps = [];
    restore = [];
    const get = spyOn(store, "get").mockImplementation(() => snapshot);
    const swap = spyOn(store, "swapPanes").mockImplementation(async (a, b) => {
      swaps.push([a, b]);
    });
    restore.push(
      () => get.mockRestore(),
      () => swap.mockRestore(),
    );
    grid = document.createElement("div");
    grid.className = "pane-layout";
    document.body.append(grid);
    const source = document.createElement("div");
    source.className = "pane-layout-cell";
    source.dataset.paneId = "a";
    target = document.createElement("div");
    target.className = "pane-layout-cell";
    target.dataset.paneId = "c"; // A nonadjacent target must swap directly.
    grid.append(source, target);
    hit = target;
    const point = spyOn(document, "elementFromPoint").mockImplementation(
      () => hit,
    );
    restore.push(() => point.mockRestore());
    root = createRoot(source);
    await act(async () =>
      root.render(
        createElement(
          "div",
          { className: "terminal-shell" },
          createElement(PaneDragHandle, {
            paneId: "a",
            layout,
            onPointerDown: (e) => e.preventDefault(),
          }),
          createElement(
            "div",
            { className: "terminal-pane-toolbar" },
            createElement(PaneMoveMenu, {
              paneId: "a",
              layout,
              onPointerDown: (e) => e.preventDefault(),
            }),
          ),
        ),
      ),
    );
    button = source.querySelector('[aria-label="Drag pane to swap"]')!;
    menuButton = source.querySelector('[aria-label="Move pane"]')!;
    let captured = false;
    button.setPointerCapture = () => {
      captured = true;
    };
    button.hasPointerCapture = () => captured;
    button.releasePointerCapture = () => {
      captured = false;
    };
  }
  async function pointer(
    type: string,
    x: number,
    options: ConstructorParameters<typeof browser.PointerEvent>[1] = {},
  ) {
    await act(async () =>
      button.dispatchEvent(
        new browser.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: 10,
          ...options,
        }) as unknown as PointerEvent,
      ),
    );
  }
  async function click(detail = 1, targetButton = menuButton) {
    await act(async () =>
      targetButton.dispatchEvent(
        new browser.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail,
        }) as unknown as MouseEvent,
      ),
    );
  }
  function clean() {
    expect(document.querySelector(".pane-move-preview")).toBeNull();
    expect(grid.querySelector(".is-swap-target, .is-swap-source")).toBeNull();
    expect(grid.classList.contains("is-swapping")).toBe(false);
    expect(button.hasPointerCapture(1)).toBe(false);
  }

  test("the separate menu opens directions; the top handle drags without opening the pad", async () => {
    await mount();
    await pointer("pointerdown", 10);
    await pointer("pointermove", 12);
    expect(document.querySelector(".pane-move-preview")).toBeNull();
    await pointer("pointerup", 12);
    await click();
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    await pointer("pointerdown", 10, { isPrimary: false });
    expect(button.hasPointerCapture(1)).toBe(false);
    await pointer("pointerdown", 10);
    await pointer("pointermove", 120, { pointerId: 2 });
    expect(target.classList.contains("is-swap-target")).toBe(false);
    await pointer("pointermove", 120, { pointerType: "touch" });
    expect(target.classList.contains("is-swap-target")).toBe(true);
    const preview = document.querySelector<HTMLElement>(".pane-move-preview")!;
    expect(preview.textContent).toBe("Pane 1Release to swap");
    expect(preview.classList.contains("is-ready")).toBe(true);
    hit = button;
    await pointer("pointermove", 160);
    expect(preview.textContent).toBe("Pane 1Drag onto another pane");
    expect(preview.classList.contains("is-ready")).toBe(false);
    expect(target.classList.contains("is-swap-target")).toBe(false);
    hit = target;
    await pointer("pointermove", 120);
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    await pointer("pointerup", 120);
    await click(1, button);
    expect(swaps).toEqual([["a", "c"]]);
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    clean();
    await click(0); // Keyboard activation still opens the direction pad.
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
  });

  test("the top handle supports arrow-key moves and the toolbar keeps directional clicks", async () => {
    await mount();
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(
      terminalFocusBlockedByOverlay(document.activeElement, document),
    ).toBe(true);
    const moves: Array<[string, string]> = [];
    const move = spyOn(store, "movePane").mockImplementation(
      async (paneId, direction) => {
        moves.push([paneId, direction]);
      },
    );
    restore.push(() => move.mockRestore());
    await act(async () =>
      button.dispatchEvent(
        new browser.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }) as unknown as KeyboardEvent,
      ),
    );
    await act(async () =>
      button.dispatchEvent(
        new browser.KeyboardEvent("keydown", {
          key: "ArrowRight",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }) as unknown as KeyboardEvent,
      ),
    );
    expect(moves).toEqual([["a", "right"]]);
    await click(0);
    const right = grid.querySelector<HTMLButtonElement>(
      '[aria-label="Move pane right"]',
    )!;
    await click(0, right);
    expect(moves).toEqual([
      ["a", "right"],
      ["a", "right"],
    ]);
    expect(swaps).toEqual([]);
  });

  for (const scale of [0.8, 1, 1.25, 1.5]) {
    test(`drag preview follows the pointer and stays in the viewport at ${scale * 100}% scale`, async () => {
      await mount();
      await pointer("pointerdown", 10);
      await pointer("pointermove", 120);
      const preview =
        document.querySelector<HTMLElement>(".pane-move-preview")!;
      Object.defineProperty(preview, "offsetWidth", { value: 190 });
      preview.getBoundingClientRect = () =>
        new browser.DOMRect(
          0,
          0,
          190 * scale,
          56 * scale,
        ) as unknown as DOMRect;
      await pointer("pointermove", 160);
      expect(preview.style.transform).toBe(
        `translate3d(${176 / scale}px, ${26 / scale}px, 0)`,
      );
      await pointer("pointermove", window.innerWidth, {
        clientY: window.innerHeight,
      });
      expect(preview.style.transform).toBe(
        `translate3d(${(window.innerWidth - 190 * scale - 8) / scale}px, ${(window.innerHeight - 56 * scale - 8) / scale}px, 0)`,
      );
      await pointer("pointercancel", 160);
      clean();
    });
  }

  test("self, outside, overlay, foreign-grid and stale targets do not swap", async () => {
    await mount();
    const foreignGrid = document.createElement("div");
    const foreign = document.createElement("div");
    foreign.className = "pane-layout-cell";
    foreign.dataset.paneId = "b";
    foreignGrid.append(foreign);
    const source = button.closest(".pane-layout-cell");
    for (const invalid of [source, null, document.body, foreign]) {
      await pointer("pointerdown", 10);
      await pointer("pointermove", 120);
      hit = invalid;
      await pointer("pointerup", 120);
      expect(swaps).toEqual([]);
      clean();
      hit = target;
    }
    await pointer("pointerdown", 10);
    await pointer("pointermove", 120);
    snapshot = {
      ...snapshot,
      layout: { ...layout, panes: layout.panes.slice(0, 2) },
    };
    await pointer("pointerup", 120);
    expect(swaps).toEqual([]);
    clean();
  });

  test("Escape cancels a drag when the app dismisses a notice in window capture", async () => {
    await mount();
    let dismissed = false;
    const dismissNotice = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismissed = true;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", dismissNotice, true);
    restore.push(() =>
      window.removeEventListener("keydown", dismissNotice, true),
    );
    await pointer("pointerdown", 10);
    await pointer("pointermove", 120);
    await act(async () =>
      button.dispatchEvent(
        new browser.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }) as unknown as KeyboardEvent,
      ),
    );
    expect(dismissed).toBe(true);
    clean();
    await pointer("pointerup", 120);
    expect(swaps).toEqual([]);
    await pointer("pointerdown", 10);
    await pointer("pointermove", 120);
    await pointer("pointerup", 120);
    expect(swaps).toEqual([["a", "c"]]);
    clean();
  });

  test("cancel, capture loss, missed release, Escape, blur, connection/tab changes and unmount clean up", async () => {
    await mount();
    for (const reason of [
      "pointercancel",
      "lostpointercapture",
      "missed",
      "Escape",
      "blur",
      "connection",
      "tab",
    ]) {
      snapshot = { ...snapshot, activeConnectionId: "original", layout };
      await pointer("pointerdown", 10);
      await pointer("pointermove", 120);
      expect(target.classList.contains("is-swap-target")).toBe(true);
      if (reason === "Escape") {
        await act(async () =>
          document.dispatchEvent(
            new browser.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }) as unknown as KeyboardEvent,
          ),
        );
      } else if (reason === "blur")
        browser.dispatchEvent(new browser.Event("blur"));
      else if (reason === "connection" || reason === "tab") {
        snapshot =
          reason === "connection"
            ? { ...snapshot, activeConnectionId: "other" }
            : { ...snapshot, layout: { ...layout, tab_id: "other" } };
        await pointer("pointerup", 120);
      } else
        await pointer(reason === "missed" ? "pointermove" : reason, 120, {
          buttons: 0,
        });
      await pointer("pointerup", 120);
      expect(swaps).toEqual([]);
      clean();
    }
    snapshot = { ...snapshot, activeConnectionId: "original", layout };
    await pointer("pointerdown", 10);
    await pointer("pointermove", 120);
    await act(async () => root.unmount());
    clean();
    await pointer("pointerup", 120);
    expect(swaps).toEqual([]);
  });
}
