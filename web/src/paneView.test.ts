import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const values = new Map<string, string>();
let failWrites = false;
const storage = {
  get length() {
    return values.size;
  },
  key: (index: number) => [...values.keys()][index] ?? null,
  getItem: (key: string) => values.get(key) ?? null,
  setItem(key: string, value: string) {
    if (failWrites) throw new Error("quota");
    values.set(key, value);
  },
  removeItem: (key: string) => void values.delete(key),
  clear: () => values.clear(),
} as Storage;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("pane view", () => {
  test("an agent pane shows its terminal until chosen otherwise", async () => {
    const { defaultPaneView, paneView } = await import("./paneView");
    expect(defaultPaneView()).toBe("terminal");
    expect(paneView("c1", "p1")).toBe("terminal");
    expect(paneView("c1", null)).toBe("terminal");
  });

  test("a pane switched by hand keeps its view when the default changes", async () => {
    const { paneView, setDefaultPaneView, setPaneView, togglePaneView } =
      await import("./paneView");
    togglePaneView("c1", "p1");
    expect(paneView("c1", "p1")).toBe("chat");
    // Another connection's pane with the same id is another pane.
    expect(paneView("c2", "p1")).toBe("terminal");
    setPaneView("c1", "p2", "terminal");
    setDefaultPaneView("chat");
    expect(paneView("c1", "p2")).toBe("terminal");
    expect(paneView("c1", "p3")).toBe("chat");
    expect(values.get("roamgate:paneViewDefault")).toBe("chat");
    setDefaultPaneView("terminal");
  });

  test("remembers the 200 most recent choices only", async () => {
    const { paneView, setPaneView } = await import("./paneView");
    for (let index = 0; index < 205; index++)
      setPaneView("c9", `pane-${index}`, "chat");
    const stored = JSON.parse(values.get("roamgate:paneViews") ?? "{}");
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored["c9:pane-0"]).toBeUndefined();
    expect(paneView("c9", "pane-0")).toBe("terminal");
    expect(paneView("c9", "pane-204")).toBe("chat");
  });

  test("a choice holds for the page when storage refuses it", async () => {
    const { paneView, setPaneView } = await import("./paneView");
    failWrites = true;
    try {
      setPaneView("c1", "p-full", "chat");
      expect(paneView("c1", "p-full")).toBe("chat");
    } finally {
      failWrites = false;
    }
  });
});
