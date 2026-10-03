import { expect, test } from "bun:test";
import { roamgateStorage, subscribeLocalStorage } from "./browserStorage";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

test("fresh browser writes use Roamgate keys", () => {
  const raw = memoryStorage();
  const storage = roamgateStorage(raw);
  storage.setItem("theme", "dark");
  expect(raw.getItem("roamgate:theme")).toBe("dark");
  expect(raw.getItem("theme")).toBeNull();
});

test("legacy preferences, drafts and connection selections copy once; new empty values win", () => {
  for (const key of [
    "theme",
    "reviewAnnotations:resource",
    "herdr.connection/one/filePreview",
  ]) {
    const raw = memoryStorage({ [key]: "saved" });
    expect(roamgateStorage(raw).getItem(key)).toBe("saved");
    expect(raw.getItem(`roamgate:${key}`)).toBe("saved");
    raw.setItem(key, "stale");
    expect(roamgateStorage(raw).getItem(key)).toBe("saved");
    raw.setItem(`roamgate:${key}`, "");
    expect(roamgateStorage(raw).getItem(key)).toBe("");
    expect(raw.getItem(key)).toBe("stale");
  }
});

test("clearing migrated values does not resurrect originals on reload", () => {
  const raw = memoryStorage({ theme: "dark" });
  const storage = roamgateStorage(raw);
  expect(storage.getItem("theme")).toBe("dark");
  storage.removeItem("theme");
  expect(roamgateStorage(raw).getItem("theme")).toBeNull();
  expect(raw.getItem("theme")).toBe("dark");
  storage.setItem("theme", "light");
  expect(storage.getItem("theme")).toBe("light");
});

test("failed migration reads saved values and can retry", () => {
  const raw = memoryStorage({ theme: "dark" });
  const setItem = raw.setItem;
  raw.setItem = () => {
    throw new Error("quota exceeded");
  };
  expect(roamgateStorage(raw).getItem("theme")).toBe("dark");
  raw.setItem = setItem;
  expect(roamgateStorage(raw).getItem("theme")).toBe("dark");
  expect(raw.getItem("roamgate:theme")).toBe("dark");
});

test("enumeration keeps legacy connection migration working without duplicate keys", () => {
  const raw = memoryStorage({
    "diffViewerSelected:one": "saved",
    "roamgate:diffViewerSelected:one": "new",
  });
  const storage = roamgateStorage(raw);
  expect(storage.length).toBe(1);
  expect(storage.key(0)).toBe("diffViewerSelected:one");
  storage.clear();
  expect(storage.getItem("diffViewerSelected:one")).toBeNull();
  expect(raw.getItem("diffViewerSelected:one")).toBe("saved");
});

test("local subscriptions normalize keys, reread effective values and ignore session events", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const target = new EventTarget();
  const raw = memoryStorage({ theme: "dark", "roamgate:theme": "light" });
  const storage = roamgateStorage(raw);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: raw,
  });
  const changes: Array<[string | null, string | null]> = [];
  const unsubscribe = subscribeLocalStorage((key) => {
    changes.push([key, storage.getItem("theme")]);
  });
  const dispatch = (key: string | null, storageArea: Storage = raw) => {
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key, storageArea }),
    );
  };
  try {
    dispatch("theme");
    expect(changes.pop()).toEqual(["theme", "light"]);
    raw.setItem("roamgate:theme", "dark");
    dispatch("roamgate:theme");
    expect(changes.pop()).toEqual(["theme", "dark"]);
    storage.removeItem("theme");
    dispatch("roamgate:deleted:theme");
    expect(changes.pop()).toEqual(["theme", null]);
    dispatch("roamgate:deleted:workspaceInspector%3Aone");
    expect(changes.pop()).toEqual(["workspaceInspector:one", null]);
    dispatch("roamgate:deleted:%invalid");
    dispatch("roamgate:theme", memoryStorage());
    expect(changes).toEqual([]);
    storage.setItem("theme", "light");
    storage.clear();
    dispatch(null);
    expect(changes.pop()).toEqual([null, null]);
    unsubscribe();
    dispatch("roamgate:theme");
    expect(changes).toEqual([]);
  } finally {
    unsubscribe();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousStorage)
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
