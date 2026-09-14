/// <reference types="bun-types" />

import { beforeEach, describe, expect, test } from "bun:test";
import { roamgateLocalStorage } from "./browserStorage";
import { defaultShortcutBindings } from "./shortcutBindings";
import type { ShortcutPreset } from "./shortcutPreferences";
import {
  adoptShortcutPreferences,
  connectShortcutPreferences,
  disconnectShortcutPreferences,
  getShortcutSnapshot,
  saveShortcutPreset,
  SHORTCUT_STORAGE_KEY,
  shortcutPresetPlatformMismatch,
} from "./shortcutPreferences";

// Ids must match /^custom-[\w-]+$/ or validateShortcutPreset renames them,
// which would drop `active` back to "auto".
function preset(id: string, base: "mac" | "linux" | "windows"): ShortcutPreset {
  const bindings = defaultShortcutBindings(base);
  return {
    id,
    name: `${id} preset`,
    base,
    bindings: { ...bindings, "sidebar.toggle": ["Ctrl+Alt+Y"] },
  };
}

/** Saves a preset as the user would, and returns the id it was given. */
function saveAndSelect(name: string) {
  saveShortcutPreset(name, preset("custom-source", "linux"));
  return getShortcutSnapshot().preferences.active;
}

function preferences(active: string, ...presets: ShortcutPreset[]) {
  return { version: 1 as const, active, presets };
}

// Bun's test runner has no DOM; the module only needs a Storage shape.
function installMemoryStorage() {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      clear: () => entries.clear(),
      key: (index: number) => [...entries.keys()][index] ?? null,
      get length() {
        return entries.size;
      },
    } satisfies Storage,
  });
}

beforeEach(() => {
  installMemoryStorage();
  disconnectShortcutPreferences();
  adoptShortcutPreferences(null);
});

describe("shortcut preferences across browsers", () => {
  test("a stored preference replaces whatever this browser had cached", () => {
    const local = preferences("custom-local", preset("custom-local", "linux"));
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(local));
    adoptShortcutPreferences(null);

    const server = preferences(
      "custom-shared",
      preset("custom-shared", "linux"),
    );
    connectShortcutPreferences(async () => undefined, server);

    expect(getShortcutSnapshot().preferences.active).toBe("custom-shared");
  });

  test("a browser that customised bindings first promotes them once", async () => {
    const local = preferences("custom-local", preset("custom-local", "linux"));
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(local));
    adoptShortcutPreferences(local);

    const sent: unknown[] = [];
    connectShortcutPreferences(async (value) => {
      sent.push(value);
    }, undefined);
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect((sent[0] as typeof local).active).toBe("custom-local");

    // Reconnecting against a server that now holds it must not push again.
    disconnectShortcutPreferences();
    connectShortcutPreferences(async (value) => {
      sent.push(value);
    }, local);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  test("nothing is promoted when the browser only has defaults", async () => {
    const sent: unknown[] = [];
    connectShortcutPreferences(async (value) => {
      sent.push(value);
    }, undefined);
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  test("an explicit platform choice is promoted even without a custom preset", async () => {
    adoptShortcutPreferences({ version: 1, active: "windows", presets: [] });
    const sent: Array<{ active: string }> = [];
    disconnectShortcutPreferences();
    connectShortcutPreferences(async (value) => {
      sent.push(value as { active: string });
    }, undefined);
    await Promise.resolve();
    expect(sent.map((value) => value.active)).toEqual(["windows"]);
  });

  test("a change made while disconnected is sent on reconnect, not overwritten", async () => {
    connectShortcutPreferences(async () => undefined, undefined);
    disconnectShortcutPreferences();
    const offline = saveAndSelect("Offline");
    expect(getShortcutSnapshot().storageError).toContain("Not connected");

    const sent: Array<{ active: string }> = [];
    const server = preferences("custom-older", preset("custom-older", "linux"));
    connectShortcutPreferences(async (value) => {
      sent.push(value as { active: string });
    }, server);
    await Promise.resolve();

    expect(getShortcutSnapshot().preferences.active).toBe(offline);
    expect(sent.map((value) => value.active)).toEqual([offline]);
  });

  test("a failed write is retried on the next connection", async () => {
    connectShortcutPreferences(async () => {
      throw new Error("bridge restarting");
    }, undefined);
    const retried = saveAndSelect("Retry");
    await Promise.resolve();
    expect(getShortcutSnapshot().storageError).toContain("bridge restarting");

    disconnectShortcutPreferences();
    const sent: Array<{ active: string }> = [];
    connectShortcutPreferences(
      async (value) => {
        sent.push(value as { active: string });
      },
      preferences("custom-older", preset("custom-older", "linux")),
    );
    await Promise.resolve();
    expect(sent.map((value) => value.active)).toEqual([retried]);
  });

  test("a change made elsewhere is adopted and cached locally", () => {
    const pushed = preferences(
      "custom-pushed",
      preset("custom-pushed", "linux"),
    );
    adoptShortcutPreferences(pushed);

    expect(getShortcutSnapshot().preferences.active).toBe("custom-pushed");
    expect(
      JSON.parse(roamgateLocalStorage.getItem(SHORTCUT_STORAGE_KEY)!).active,
    ).toBe("custom-pushed");
  });

  test("clearing the preference elsewhere restores the defaults", () => {
    adoptShortcutPreferences(
      preferences("custom-gone", preset("custom-gone", "linux")),
    );
    adoptShortcutPreferences(null);

    expect(getShortcutSnapshot().preferences.presets).toEqual([]);
    expect(getShortcutSnapshot().preferences.active).toBe("auto");
  });
});

describe("cross-platform guard", () => {
  test("a preset written for another platform is reported, not applied", () => {
    const mac = preferences(
      "custom-mac-tweaks",
      preset("custom-mac-tweaks", "mac"),
    );

    expect(shortcutPresetPlatformMismatch(mac, "linux")?.id).toBe(
      "custom-mac-tweaks",
    );
    expect(shortcutPresetPlatformMismatch(mac, "mac")).toBeNull();
  });

  test("the mismatching browser falls back to its own platform defaults", () => {
    adoptShortcutPreferences(
      preferences("custom-mac-tweaks", preset("custom-mac-tweaks", "mac")),
    );
    const snapshot = getShortcutSnapshot();

    if (snapshot.platform === "mac") {
      expect(snapshot.preset.id).toBe("custom-mac-tweaks");
      expect(snapshot.platformMismatch).toBeNull();
      return;
    }
    expect(snapshot.preset.id).toBe("auto");
    expect(snapshot.preset.base).toBe(snapshot.platform);
    expect(snapshot.preset.bindings["sidebar.toggle"]).toEqual(
      defaultShortcutBindings(snapshot.platform)["sidebar.toggle"],
    );
    expect(snapshot.platformMismatch?.id).toBe("custom-mac-tweaks");
  });
});
