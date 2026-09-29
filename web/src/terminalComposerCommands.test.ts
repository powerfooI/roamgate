import { describe, expect, test } from "bun:test";
import {
  completeComposerCommand,
  composerCommandPrefix,
  filterComposerCommands,
  terminalComposerCommands,
} from "./terminalComposerCommands";

const compact = { name: "/compact", description: "Compact context" };

describe("composer command catalogs", () => {
  test("resolves only explicit aliases, never substrings or object properties", () => {
    for (const names of [
      ["claude", "claude-code", " Claude Code "],
      ["codex", "codex-cli", "CODEX CLI"],
      ["pi", "pi-agent", "pi-coding-agent"],
      ["kimi", "kimi-code", "Kimi Code", "kimi-cli"],
      ["grok", "grok-build", " Grok Build "],
      ["agy", "antigravity", "antigravity-cli", " Antigravity CLI "],
    ]) {
      const commands = terminalComposerCommands(names[0]);
      expect(commands.length).toBeGreaterThan(0);
      expect(new Set(commands.map((command) => command.name)).size).toBe(
        commands.length,
      );
      for (const alias of names)
        expect(terminalComposerCommands(alias)).toBe(commands);
    }
    for (const agent of [
      undefined,
      "",
      "shell",
      "custom-claude",
      "custom-grok",
      "agy-custom",
      "grok --model x",
      "copilot",
      "pi --model x",
      "constructor",
      "__proto__",
    ]) {
      expect(terminalComposerCommands(agent)).toEqual([]);
    }
    expect(terminalComposerCommands("pi").some((c) => c.name === "/tree")).toBe(
      true,
    );
    expect(
      terminalComposerCommands("codex").some((c) => c.name === "/tree"),
    ).toBe(false);
    expect(
      terminalComposerCommands("kimi").some((c) => c.name === "/sessions"),
    ).toBe(true);
    expect(
      terminalComposerCommands("claude").some((c) => c.name === "/sessions"),
    ).toBe(false);
  });

  test("catalogs cover common workflows with insertable command names", () => {
    const workflows = {
      claude: ["/config", "/permissions", "/memory", "/skills", "/rewind"],
      codex: ["/review", "/permissions", "/skills", "/mcp", "/ps"],
      pi: ["/thinking", "/reload", "/export", "/hotkeys", "/trust"],
      kimi: ["/plan", "/task", "/undo", "/mcp", "/add-dir"],
      grok: ["/sessions", "/view-plan", "/mcps", "/workflows", "/session-info"],
      agy: ["/planning", "/artifact", "/agents", "/mcp", "/permissions"],
    };
    for (const [agent, expected] of Object.entries(workflows)) {
      const commands = terminalComposerCommands(agent);
      expect(commands.length).toBeGreaterThanOrEqual(20);
      expect(commands.map((command) => command.name)).toEqual(
        expect.arrayContaining(expected),
      );
      for (const command of commands) {
        expect(command.name).toMatch(/^\/[a-z][a-z0-9-]*$/);
        expect(command.description.trim().length).toBeGreaterThan(0);
        expect(completeComposerCommand("/", command, 1)?.text).toBe(
          `${command.name} `,
        );
      }
    }
  });

  test("Grok and Antigravity keep their own command spellings", () => {
    const grok = terminalComposerCommands("grok-build");
    const agy = terminalComposerCommands("antigravity-cli");
    expect(filterComposerCommands(grok, "/mcp").map((c) => c.name)).toEqual([
      "/mcps",
    ]);
    expect(filterComposerCommands(agy, "/mcp").map((c) => c.name)).toEqual([
      "/mcp",
    ]);
    expect(filterComposerCommands(grok, "/plan").map((c) => c.name)).toEqual([
      "/plan",
    ]);
    expect(filterComposerCommands(agy, "/plan").map((c) => c.name)).toEqual([
      "/planning",
    ]);
    expect(grok.some((c) => c.name === "/planning")).toBe(false);
    expect(agy.some((c) => c.name === "/compact")).toBe(false);
  });

  test("inline completion only matches command prefixes", () => {
    const commands = terminalComposerCommands("claude");
    expect(filterComposerCommands(commands, "")).toEqual(commands);
    expect(filterComposerCommands(commands, "/")).toEqual(commands);
    expect(
      filterComposerCommands(commands, "  /CO  ").map((c) => c.name),
    ).toEqual(["/compact", "/config", "/context", "/copy"]);
    expect(filterComposerCommands(commands, "conversation")).toEqual([]);
    expect(filterComposerCommands(commands, "/custom")).toEqual([]);
    expect(filterComposerCommands([], "")).toEqual([]);
  });
});

describe("composer command completion", () => {
  test("offers inline completion only at a leading token's selection", () => {
    expect(composerCommandPrefix("/", 1)).toBe("/");
    expect(composerCommandPrefix("/co keep arguments", 3)).toBe("/co");
    expect(composerCommandPrefix("/custom:command", 4)).toBe("/custom:command");
    for (const [text, start, end] of [
      ["", 0, 0],
      [" /co", 4, 4],
      ["text /co", 8, 8],
      ["/co args", 5, 5],
      ["/co args", 1, 5],
      ["/co", 0, 0],
      ["/co\nnext", 4, 4],
    ] as const)
      expect(composerCommandPrefix(text, start, end)).toBeNull();
  });

  test("replaces only the command token and preserves exact whitespace and arguments", () => {
    expect(completeComposerCommand("/co", compact, 3)).toEqual({
      text: "/compact ",
      start: 9,
      end: 9,
    });
    expect(
      completeComposerCommand("/co  中文\n--file '/tmp/a b'", compact, 2, 3),
    ).toEqual({
      text: "/compact  中文\n--file '/tmp/a b'",
      start: 8,
      end: 8,
    });
    expect(completeComposerCommand("/co\targ", compact, 5, 7)).toEqual({
      text: "/compact\targ",
      start: 10,
      end: 12,
    });
    expect(
      completeComposerCommand(
        "/compact args",
        { name: "/new", description: "New session" },
        11,
        13,
      ),
    ).toEqual({ text: "/new args", start: 7, end: 9 });
    expect(completeComposerCommand("/", compact, 1)).toEqual({
      text: "/compact ",
      start: 9,
      end: 9,
    });
    expect(completeComposerCommand("keep /co", compact, 8)).toBeNull();
    expect(completeComposerCommand("", compact, 0)).toBeNull();
  });
});
