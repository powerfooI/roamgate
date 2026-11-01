import { expect, test } from "bun:test";
import { matchCommands } from "./claudeCommands";

const commands = ["clear", "compact", "commit", "codex:rescue", "context"].map(
  (name) => ({ name, description: "" }),
);

test("a command being typed lists the matches, prefix first", () => {
  expect(matchCommands("/co", commands).map((c) => c.name)).toEqual([
    "compact",
    "commit",
    "codex:rescue",
    "context",
  ]);
  expect(matchCommands("/resc", commands).map((c) => c.name)).toEqual([
    "codex:rescue",
  ]);
  expect(matchCommands("/", commands, 2).map((c) => c.name)).toEqual([
    "clear",
    "compact",
  ]);
});

test("anything but a command being typed lists nothing", () => {
  expect(matchCommands("/compact now", commands)).toEqual([]);
  expect(matchCommands("hi /co", commands)).toEqual([]);
  expect(matchCommands("", commands)).toEqual([]);
});
