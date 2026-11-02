import { afterAll, beforeAll, expect, test } from "bun:test";

const values = new Map<string, string>();
let failWrites = false;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
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
    } as Storage,
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

test("Vim keys in chat boxes are off until turned on, and stay chosen", async () => {
  const { composerVimKeys, setComposerVimKeys } = await import("./composerVim");
  expect(composerVimKeys()).toBe(false);
  setComposerVimKeys(true);
  expect(composerVimKeys()).toBe(true);
  expect(values.get("roamgate:agentChatVimKeys")).toBe("true");
  // Storage refusing the choice: it still holds for this page.
  failWrites = true;
  try {
    setComposerVimKeys(false);
    expect(composerVimKeys()).toBe(false);
  } finally {
    failWrites = false;
  }
  setComposerVimKeys(false);
  expect(composerVimKeys()).toBe(false);
});
