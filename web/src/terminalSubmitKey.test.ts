import { expect, spyOn, test } from "bun:test";
import { roamgateLocalStorage } from "./browserStorage";
import {
  normalizeTerminalSubmitKey,
  setTerminalSubmitKey,
  terminalSubmitKey,
} from "./terminalSubmitKey";

test("terminal submit preference defaults safely and survives storage failures", () => {
  expect(normalizeTerminalSubmitKey(null)).toBe("enter");
  expect(normalizeTerminalSubmitKey("bad-value")).toBe("enter");
  expect(normalizeTerminalSubmitKey("meta-enter")).toBe("meta-enter");
  const read = spyOn(roamgateLocalStorage, "getItem").mockReturnValue("enter");
  const write = spyOn(roamgateLocalStorage, "setItem").mockImplementation(
    () => {
      throw new Error("storage unavailable");
    },
  );
  try {
    setTerminalSubmitKey("meta-enter");
    expect(terminalSubmitKey()).toBe("meta-enter");
    write.mockImplementation(() => {});
    setTerminalSubmitKey("enter");
    expect(terminalSubmitKey()).toBe("enter");
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
