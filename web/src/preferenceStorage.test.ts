import { expect, test } from "bun:test";
import { Window } from "happy-dom";

type Scenario = "legacy" | "current" | "events";
const scenarios: Scenario[] = ["legacy", "current", "events"];
const scenario = process.env.ROAMGATE_PREFERENCE_STORAGE_TEST;

if (scenario) {
  test(`preference storage: ${scenario}`, () =>
    checkPreferenceStorage(scenario as Scenario));
} else {
  test.each(scenarios)(
    "layout and shortcut %s storage works in an isolated runtime",
    async (scenario) => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, ROAMGATE_PREFERENCE_STORAGE_TEST: scenario },
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
    },
    15_000,
  );
}

async function checkPreferenceStorage(scenario: Scenario) {
  const browser = new Window({ url: "http://localhost" });
  browser.happyDOM.setWindowSize({ width: 1024, height: 768 });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    Event: browser.Event,
  })) {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const layoutKey = "layoutPreferences.v1";
    const shortcutKey = "keyboardShortcuts.v1";
    const raw = browser.localStorage;
    const writeLayout = (key: string, mode: string) =>
      raw.setItem(key, JSON.stringify({ mode }));
    const writeShortcuts = (key: string, active: string) =>
      raw.setItem(key, JSON.stringify({ version: 1, active, presets: [] }));
    const storageEvent = (key: string | null, storageArea = raw) =>
      browser.dispatchEvent(
        new browser.StorageEvent("storage", {
          ...(key === null ? {} : { key }),
          storageArea,
        }),
      );

    if (scenario !== "events") {
      writeLayout(layoutKey, "mobile");
      writeShortcuts(shortcutKey, "mac");
      if (scenario === "current") {
        writeLayout(`roamgate:${layoutKey}`, "desktop");
        writeShortcuts(`roamgate:${shortcutKey}`, "windows");
      }
    }
    const layout = await import("./layoutPreferences");
    const shortcuts = await import("./shortcutPreferences");
    const { roamgateLocalStorage } = await import("./browserStorage");
    layout.initializeLayoutPreferences();
    shortcuts.initializeShortcutPreferences();
    const expectPreferences = (mobile: boolean, active: string) => {
      expect(layout.isMobileLayout()).toBe(mobile);
      expect(browser.document.documentElement.dataset.layout).toBe(
        mobile ? "mobile" : "desktop",
      );
      expect(shortcuts.getShortcutSnapshot().preferences.active).toBe(active);
    };

    if (scenario === "legacy") {
      expectPreferences(true, "mac");
      for (const key of [layoutKey, shortcutKey])
        expect(raw.getItem(`roamgate:${key}`)).toBe(raw.getItem(key));
      const legacyLayout = raw.getItem(layoutKey);
      const legacyShortcuts = raw.getItem(shortcutKey);
      layout.updateLayoutPreferences({ mode: "desktop" });
      shortcuts.selectShortcutPreset("windows");
      expectPreferences(false, "windows");
      expect(raw.getItem(layoutKey)).toBe(legacyLayout);
      expect(raw.getItem(shortcutKey)).toBe(legacyShortcuts);
      expect(JSON.parse(raw.getItem(`roamgate:${layoutKey}`)!).mode).toBe(
        "desktop",
      );
      expect(JSON.parse(raw.getItem(`roamgate:${shortcutKey}`)!).active).toBe(
        "windows",
      );
    } else if (scenario === "current") {
      expectPreferences(false, "windows");
      roamgateLocalStorage.clear();
      for (const key of [layoutKey, shortcutKey]) {
        expect(raw.getItem(key)).not.toBeNull();
        expect(raw.getItem(`roamgate:${key}`)).toBeNull();
        expect(raw.getItem(`roamgate:deleted:${encodeURIComponent(key)}`)).toBe(
          "1",
        );
        expect(roamgateLocalStorage.getItem(key)).toBeNull();
      }
      storageEvent(null);
      expectPreferences(false, "auto");
    } else {
      expectPreferences(false, "auto");
      layout.updateLayoutPreferences({ mode: "mobile" });
      shortcuts.selectShortcutPreset("windows");
      expectPreferences(true, "windows");
      expect(raw.getItem(layoutKey)).toBeNull();
      expect(raw.getItem(shortcutKey)).toBeNull();
      expect(JSON.parse(raw.getItem(`roamgate:${layoutKey}`)!).mode).toBe(
        "mobile",
      );
      expect(JSON.parse(raw.getItem(`roamgate:${shortcutKey}`)!).active).toBe(
        "windows",
      );
      raw.clear();
      storageEvent(null);
      expectPreferences(false, "auto");
      writeLayout(layoutKey, "mobile");
      writeShortcuts(shortcutKey, "mac");
      storageEvent(layoutKey);
      storageEvent(shortcutKey);
      expectPreferences(true, "mac");
      writeLayout(`roamgate:${layoutKey}`, "desktop");
      writeShortcuts(`roamgate:${shortcutKey}`, "windows");
      storageEvent(`roamgate:${layoutKey}`);
      storageEvent(`roamgate:${shortcutKey}`);
      expectPreferences(false, "windows");

      writeLayout(`roamgate:${layoutKey}`, "mobile");
      writeShortcuts(`roamgate:${shortcutKey}`, "linux");
      storageEvent(`roamgate:${layoutKey}`, browser.sessionStorage);
      storageEvent(`roamgate:${shortcutKey}`, browser.sessionStorage);
      storageEvent("roamgate:unrelated");
      expectPreferences(false, "windows");
      storageEvent(`roamgate:${layoutKey}`);
      storageEvent(`roamgate:${shortcutKey}`);
      expectPreferences(true, "linux");

      // A legacy-only deletion emits a marker event without removing a new key.
      for (const key of [layoutKey, shortcutKey]) {
        raw.removeItem(`roamgate:${key}`);
        roamgateLocalStorage.removeItem(key);
        storageEvent(`roamgate:deleted:${encodeURIComponent(key)}`);
      }
      expectPreferences(false, "auto");
      expect(raw.getItem(layoutKey)).not.toBeNull();
      expect(raw.getItem(shortcutKey)).not.toBeNull();

      writeLayout(`roamgate:${layoutKey}`, "mobile");
      writeShortcuts(`roamgate:${shortcutKey}`, "windows");
      storageEvent(`roamgate:${layoutKey}`);
      storageEvent(`roamgate:${shortcutKey}`);
      expectPreferences(true, "windows");
      raw.clear();
      storageEvent(null);
      expectPreferences(false, "auto");
    }
  } finally {
    await browser.happyDOM.close();
  }
}
