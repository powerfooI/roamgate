import { afterAll, expect, test } from "bun:test";

const values = new Map<string, string>();
let failWrites = false;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  },
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const {
  parseTerminalOptionAsMeta,
  setTerminalOptionAsMeta,
  terminalOptionAsMeta,
  TERMINAL_OPTION_AS_META_STORAGE_KEY,
} = await import("./terminalOptionKey");
const key = `roamgate:${TERMINAL_OPTION_AS_META_STORAGE_KEY}`;

test("Option keeps typing characters unless the user opts in", () => {
  for (const value of [null, "", "false", "1", "yes", "TRUE"])
    expect(parseTerminalOptionAsMeta(value)).toBe(false);
  expect(parseTerminalOptionAsMeta("true")).toBe(true);
  expect(terminalOptionAsMeta()).toBe(false);
});

test("the choice is stored in this browser and read back", () => {
  setTerminalOptionAsMeta(true);
  expect(values.get(key)).toBe("true");
  expect(terminalOptionAsMeta()).toBe(true);
  setTerminalOptionAsMeta(false);
  expect(values.get(key)).toBe("false");
  expect(terminalOptionAsMeta()).toBe(false);
});

test("blocked storage still applies the choice to this page", () => {
  failWrites = true;
  try {
    setTerminalOptionAsMeta(true);
    expect(terminalOptionAsMeta()).toBe(true);
  } finally {
    failWrites = false;
    setTerminalOptionAsMeta(false);
  }
});
