import { expect, test } from "bun:test";
import { promptKeyInput } from "./promptKeys";

const key = (name: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

test("the menu's keys go to the pane as the terminal sends them", () => {
  expect(promptKeyInput(key("ArrowDown"), false)).toBe("\x1b[B");
  expect(promptKeyInput(key("j"), false)).toBe("\x1b[B");
  expect(promptKeyInput(key("k"), false)).toBe("\x1b[A");
  expect(promptKeyInput(key("l"), false)).toBe("\x1b[C");
  expect(promptKeyInput(key("Tab"), false)).toBe("\t");
  expect(promptKeyInput(key("Tab", { shiftKey: true }), false)).toBe("\x1b[Z");
  expect(promptKeyInput(key("Enter"), false)).toBe("\r");
  expect(promptKeyInput(key("Escape"), false)).toBe("\x1b");
  expect(promptKeyInput(key("3"), false)).toBe("3");
  expect(promptKeyInput(key(" "), false)).toBe(" ");
});

test("other keys stay", () => {
  expect(promptKeyInput(key("i"), false)).toBeNull();
  expect(promptKeyInput(key("x"), false)).toBeNull();
  expect(promptKeyInput(key("0"), false)).toBeNull();
  expect(promptKeyInput(key("j", { metaKey: true }), false)).toBeNull();
});

test("an answer of one's own is written in the message box", () => {
  expect(promptKeyInput(key("j"), true)).toBe("box");
  expect(promptKeyInput(key("i"), true)).toBe("box");
  expect(promptKeyInput(key("Backspace"), true)).toBeNull();
  expect(promptKeyInput(key("ArrowUp"), true)).toBe("\x1b[A");
  expect(promptKeyInput(key("Enter"), true)).toBe("\r");
});
