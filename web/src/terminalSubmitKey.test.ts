import { expect, spyOn, test } from "bun:test";
import { roamgateLocalStorage } from "./browserStorage";
import {
  normalizeTerminalSubmitKey,
  setTerminalSubmitKey,
  terminalSubmitHerdrKey,
  terminalSubmitKey,
} from "./terminalSubmitKey";

test("each agent keeps its own submit key; others and shells use Enter", () => {
  expect(normalizeTerminalSubmitKey("bad-value")).toBe("enter");
  expect(terminalSubmitHerdrKey("meta-enter")).toBe("super+enter");
  const stored = new Map<string, string>();
  const read = spyOn(roamgateLocalStorage, "getItem").mockImplementation(
    (name) => stored.get(name) ?? null,
  );
  const write = spyOn(roamgateLocalStorage, "setItem").mockImplementation(
    (name, value) => void stored.set(name, value),
  );
  const remove = spyOn(roamgateLocalStorage, "removeItem").mockImplementation(
    (name) => void stored.delete(name),
  );
  try {
    setTerminalSubmitKey("omp", "meta-enter");
    expect(terminalSubmitKey("omp")).toBe("meta-enter");
    expect(terminalSubmitKey("claude")).toBe("enter");
    expect(terminalSubmitKey(undefined)).toBe("enter");
    expect(terminalSubmitKey("toString")).toBe("enter");
    setTerminalSubmitKey("omp", "enter");
    expect(stored.size).toBe(0);
    // Unknown values and broken JSON fall back to Enter.
    stored.set("terminalSubmitKeys.v1", '{"omp":"hyper-enter"}');
    expect(terminalSubmitKey("omp")).toBe("enter");
    stored.set("terminalSubmitKeys.v1", "not json");
    expect(terminalSubmitKey("omp")).toBe("enter");
    stored.clear();
    // A choice storage refuses still holds for this page.
    write.mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    setTerminalSubmitKey("omp", "meta-enter");
    expect(terminalSubmitKey("omp")).toBe("meta-enter");
    write.mockImplementation((name, value) => void stored.set(name, value));
    setTerminalSubmitKey("omp", "enter");
    expect(terminalSubmitKey("omp")).toBe("enter");
  } finally {
    read.mockRestore();
    write.mockRestore();
    remove.mockRestore();
  }
});
