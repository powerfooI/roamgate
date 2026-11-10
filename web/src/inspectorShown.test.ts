import { expect, test } from "bun:test";
import {
  INSPECTOR_SHOWN_STORAGE_KEY,
  inspectorWasShown,
  rememberInspectorShown,
} from "./inspectorShown";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

test("the inspector is shown per connection and workspace", () => {
  const storage = memoryStorage();
  // Never shown: today's default, hidden.
  expect(inspectorWasShown(storage, "alpha", "w1")).toBe(false);

  rememberInspectorShown(storage, "alpha", "w1", true);
  expect(inspectorWasShown(storage, "alpha", "w1")).toBe(true);
  // Not in the other workspaces, nor in the same id on another connection.
  expect(inspectorWasShown(storage, "alpha", "w2")).toBe(false);
  expect(inspectorWasShown(storage, "beta", "w1")).toBe(false);

  rememberInspectorShown(storage, "beta", "w1", true);
  rememberInspectorShown(storage, "alpha", "w1", false);
  expect(inspectorWasShown(storage, "alpha", "w1")).toBe(false);
  expect(inspectorWasShown(storage, "beta", "w1")).toBe(true);

  // Nothing shown anywhere: nothing kept.
  rememberInspectorShown(storage, "beta", "w1", false);
  expect(storage.items.has(INSPECTOR_SHOWN_STORAGE_KEY)).toBe(false);
});

test("a malformed or unwritable value reads as hidden", () => {
  const storage = memoryStorage();
  storage.setItem(INSPECTOR_SHOWN_STORAGE_KEY, "{not json");
  expect(inspectorWasShown(storage, "alpha", "w1")).toBe(false);
  storage.setItem(
    INSPECTOR_SHOWN_STORAGE_KEY,
    JSON.stringify({ version: 2, connections: { alpha: ["w1"] } }),
  );
  expect(inspectorWasShown(storage, "alpha", "w1")).toBe(false);
  const full = {
    ...memoryStorage(),
    setItem: () => {
      throw new Error("quota");
    },
  };
  expect(() => rememberInspectorShown(full, "alpha", "w1", true)).not.toThrow();
  expect(inspectorWasShown(full, "alpha", "w1")).toBe(false);
});
