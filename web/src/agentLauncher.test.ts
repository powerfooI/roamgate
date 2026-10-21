import { afterEach, expect, spyOn, test } from "bun:test";
import {
  readAgentLaunchCommand,
  saveAgentLaunchCommand,
  validateAgentLaunchCommand,
} from "./agentLauncher";
import { roamgateLocalStorage } from "./browserStorage";

const storageSpies: Array<{ mockRestore: () => void }> = [];
afterEach(() => storageSpies.splice(0).forEach((spy) => spy.mockRestore()));

test("launch commands persist per connection and agent and reset to the detected default", () => {
  const values = new Map<string, string>();
  storageSpies.push(
    spyOn(roamgateLocalStorage, "getItem").mockImplementation(
      (key) => values.get(key) ?? null,
    ),
    spyOn(roamgateLocalStorage, "setItem").mockImplementation((key, value) => {
      values.set(key, value);
    }),
    spyOn(roamgateLocalStorage, "removeItem").mockImplementation((key) => {
      values.delete(key);
    }),
  );
  expect(readAgentLaunchCommand("local", "claude", "claude")).toBe("claude");
  const command = 'CUSTOM_MODE=1 "/path with spaces/claude" --model "my model"';
  saveAgentLaunchCommand("local", "claude", command, "claude");
  expect(readAgentLaunchCommand("local", "claude", "claude")).toBe(command);
  expect(readAgentLaunchCommand("remote", "claude", "claude")).toBe("claude");
  expect(readAgentLaunchCommand("local", "pi", "pi")).toBe("pi");
  saveAgentLaunchCommand("local", "claude", "claude", "claude");
  expect(readAgentLaunchCommand("local", "claude", "new-default")).toBe(
    "new-default",
  );
});

test("storage failures are reported instead of claiming a command was saved", () => {
  storageSpies.push(
    spyOn(roamgateLocalStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    }),
  );
  expect(() =>
    saveAgentLaunchCommand("local", "pi", "pi --model custom", "pi"),
  ).toThrow("Storage full");
});

test.each(["", "  ", "pi\ncodex", "pi\r", "pi\x1b[A", "pi\0", "pi\x7f"])(
  "invalid command %j is rejected for saving and selection",
  (command) => {
    expect(() => saveAgentLaunchCommand("local", "pi", command, "pi")).toThrow(
      "single-line",
    );
    expect(() => validateAgentLaunchCommand(command)).toThrow("single-line");
  },
);
