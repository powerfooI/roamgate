import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  mobileTerminalShortcutBytes,
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { MobileTerminalShortcutsDialog } from "./MobileTerminalShortcutsDialog";

// Isolate browser globals from the other tests and React's shared module graph.
if (process.env.ROAMGATE_SHORTCUT_PICKER_DOM_TEST !== "1") {
  test("mobile shortcut picker interactions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SHORTCUT_PICKER_DOM_TEST: "1" },
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
  test("chooses multiple modifiers and one US key, validates and saves both areas", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let savedRows: MobileTerminalShortcutRows =
      defaultMobileTerminalShortcutRows();
    let savedSide: MobileTerminalSideShortcuts =
      defaultMobileTerminalSideShortcuts();
    const button = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) =>
          item.getAttribute("aria-label") === label ||
          item.textContent === label,
      )!;
    const click = async (label: string) => {
      await act(async () => button(label).click());
    };
    try {
      await act(async () =>
        root.render(
          createElement(MobileTerminalShortcutsDialog, {
            open: true,
            rows: savedRows,
            sideShortcuts: savedSide,
            onChange: (rows) => {
              savedRows = rows;
            },
            onSideChange: (side) => {
              savedSide = side;
            },
            onClose: () => {},
          }),
        ),
      );
      expect(
        container
          .querySelector("details.mobile-shortcut-help")
          ?.hasAttribute("open"),
      ).toBe(false);
      await click("Add button to row 1 slot 5");
      expect(
        container
          .querySelector('[role="combobox"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
      await click("Custom keyboard");
      await click("Preset");
      expect(button("Preset").getAttribute("aria-pressed")).toBe("true");
      await click("Custom keyboard");
      for (const key of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        expect(button(`Key ${key}`)).toBeDefined();
      for (const key of "`-=[]\\;',./")
        expect(
          button(`Key ${key}`).closest(".mobile-shortcut-keyboard"),
        ).not.toBeNull();
      expect(
        Array.from(
          container.querySelectorAll('[aria-label="Function keys"] button'),
          (key) => key.textContent,
        ),
      ).toEqual(Array.from({ length: 12 }, (_, index) => `F${index + 1}`));
      expect(
        container.querySelector(
          '[aria-label="Navigation keys"] button[aria-label="Key F1"]',
        ),
      ).toBeNull();
      await click("Key 1");
      expect(button("Save shortcuts").disabled).toBe(true);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Row 1, slot 5: Ctrl+1 cannot be sent with the current terminal encoding.",
      );
      await click("Edit row 1 slot 1, C-c, Ctrl+C");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Row 1, slot 5: Ctrl+1",
      );
      expect(button("Save shortcuts").disabled).toBe(true);
      await click("Edit row 1 slot 5, C-1, Ctrl+1");
      await click("Key X");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await click("Alt");
      await click("Shift");
      await click("Key /");
      expect(button("Key /").textContent).toBe("?");
      await click("Key Tab");
      expect(button("Save shortcuts").disabled).toBe(true);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Ctrl+Alt+Shift+Tab",
      );
      await click("Key Y");
      expect(button("Key X").getAttribute("aria-pressed")).toBe("false");
      expect(button("Key Y").getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector("output")?.textContent).toBe(
        "Ctrl+Alt+Shift+Y",
      );
      expect(button("Save shortcuts").disabled).toBe(false);
      await click("Add button to side slot 1");
      await click("Custom keyboard");
      await click("Ctrl");
      await click("Alt");
      await click("Shift");
      await click("Key 2");
      expect(button("Key 2").textContent).toBe("@");
      await click("Key [");
      expect(button("Key [").textContent).toBe("{");
      await click("Save shortcuts");
      expect(savedRows[0][4]?.action).toEqual({
        key: "y",
        ctrl: true,
        alt: true,
        shift: true,
      });
      expect(savedRows[0][4]?.label).toBe("C-A-S-Y");
      expect(mobileTerminalShortcutBytes(savedRows[0][4]!.action)).toEqual([
        0x1b, 0x19,
      ]);
      expect(savedSide[0]?.action).toEqual({
        key: "[",
        ctrl: false,
        alt: true,
        shift: true,
      });
      expect(mobileTerminalShortcutBytes(savedSide[0]!.action)).toEqual([
        0x1b, 0x7b,
      ]);
    } finally {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
