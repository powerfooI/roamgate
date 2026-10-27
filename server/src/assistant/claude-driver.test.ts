import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantConfig } from "../../../shared/assistant";
import {
  CLAUDE_CODE_PROVIDER,
  type ClaudeCodeProcess,
  createClaudeCodeDriver,
} from "./claude-driver";
import { createRangerMcp } from "./claude-mcp";

const stream = (event: unknown) => ({ type: "stream_event", event });
/** What `claude -p --output-format stream-json` says for one tool round. */
const TOOL_ROUND = [
  {
    type: "system",
    subtype: "init",
    mcp_servers: [{ name: "ranger", status: "connected" }],
  },
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  }),
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Check w7." },
  }),
  stream({ type: "content_block_stop", index: 0 }),
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__ranger__workspace_status",
          input: { workspace_id: "w7" },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "w7: idle" }],
        },
      ],
    },
  },
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "w7 is " },
  }),
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "idle." },
  }),
  {
    type: "assistant",
    message: { content: [{ type: "text", text: "w7 is idle." }] },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "w7 is idle.",
  },
];

function fakeClaude(events: unknown[], exit = 0) {
  const runs: {
    args: string[];
    cwd: string;
    written: string[];
    killed: boolean;
  }[] = [];
  const spawn = (args: string[], cwd: string): ClaudeCodeProcess => {
    const run = { args, cwd, written: [] as string[], killed: false };
    runs.push(run);
    let release: () => void = () => {};
    const killed = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      lines: (async function* () {
        for (const event of events) {
          if (event === "hang") await killed;
          else yield JSON.stringify(event);
          if (run.killed) return;
        }
      })(),
      write: (line) => run.written.push(line),
      end: () => {},
      kill: () => {
        run.killed = true;
        release();
      },
      exited: killed.then(() => 143).then((code) => code),
    };
  };
  // Processes that are not killed exit once their output is read.
  const exiting = (args: string[], cwd: string) => {
    const child = spawn(args, cwd);
    return {
      ...child,
      exited: events.includes("hang") ? child.exited : Promise.resolve(exit),
    };
  };
  return { spawn: exiting, runs };
}

function recorder() {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  return {
    calls,
    input: {
      delta: record("delta"),
      message: record("message"),
      tool: record("tool"),
      thinking: record("thinking"),
      checkpoint: record("checkpoint"),
      error: record("error"),
      sources: record("sources"),
    },
  };
}

const config = (extra: Partial<AssistantConfig> = {}): AssistantConfig => ({
  provider: CLAUDE_CODE_PROVIDER,
  model: "opus",
  credential_source: "assistant",
  allowed_workspaces: [],
  ...extra,
});

function driverFor(events: unknown[], exit = 0) {
  const directory = mkdtempSync(join(tmpdir(), "ranger-claude-"));
  const claude = fakeClaude(events, exit);
  const driver = createClaudeCodeDriver({
    directory,
    mcp: createRangerMcp(() => ({
      url: "http://127.0.0.1:1/mcp",
      stop: () => {},
    })),
    spawn: claude.spawn,
    available: () => true,
  });
  return {
    driver,
    runs: claude.runs,
    directory,
    done: () => rmSync(directory, { recursive: true }),
  };
}

const read = async () => ({ text: "" });

describe("the Claude Code driver", () => {
  test("lists Claude models, with Claude Code's effort levels", () => {
    const { driver, done } = driverFor([]);
    const catalog = driver.catalog();
    expect(catalog.providers).toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        methods: [],
        configured: true,
      },
    ]);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(catalog.models[0]!.thinking_levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    done();
  });

  test("runs a turn in a new session with only Ranger's tools", async () => {
    const { driver, runs, directory, done } = driverFor(TOOL_ROUND);
    const { calls, input } = recorder();
    const entries = await driver.run({
      ...input,
      config: config(),
      entries: [],
      text: "What is w7 doing?",
      signal: new AbortController().signal,
      read,
    });
    const [run] = runs;
    const arg = (flag: string) => run!.args[run!.args.indexOf(flag) + 1];
    expect(run!.cwd).toBe(join(directory, "claude"));
    expect(arg("--model")).toBe("opus");
    expect(run!.args).not.toContain("--effort");
    expect(arg("--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(arg("--tools")).toBe("");
    expect(run!.args).toContain("--strict-mcp-config");
    expect(arg("--allowedTools")).toBe("mcp__ranger");
    expect(JSON.parse(arg("--settings")!)).toEqual({ disableAllHooks: true });
    expect(JSON.parse(arg("--mcp-config")!).mcpServers.ranger.type).toBe(
      "http",
    );
    expect(arg("--system-prompt")).toStartWith("You are Ranger");
    expect(run!.written).toEqual([
      `${JSON.stringify({ type: "user", message: { role: "user", content: "What is w7 doing?" } })}\n`,
    ]);
    const session = arg("--session-id");
    expect(entries).toEqual([{ type: "ranger-claude", session }]);
    expect(calls).toEqual([
      ["checkpoint", [{ type: "ranger-claude", session }]],
      ["thinking", ["Check w7."]],
      [
        "tool",
        "toolu_1",
        "workspace_status",
        "running",
        { arguments: '{\n  "workspace_id": "w7"\n}' },
      ],
      [
        "tool",
        "toolu_1",
        "workspace_status",
        "completed",
        { arguments: '{\n  "workspace_id": "w7"\n}', output: "w7: idle" },
      ],
      ["delta", "w7 is "],
      ["delta", "idle."],
      ["message", "w7 is idle."],
    ]);
    done();
  });

  test("resumes the session the last turn left, at the chosen effort", async () => {
    const { driver, runs, done } = driverFor(TOOL_ROUND);
    const session = "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10";
    const { input } = recorder();
    expect(
      await driver.run({
        ...input,
        config: config({ model: "haiku", thinking_level: "low" }),
        entries: [{ type: "ranger-claude", session }],
        text: "And now?",
        signal: new AbortController().signal,
        read,
      }),
    ).toEqual([{ type: "ranger-claude", session }]);
    const args = runs[0]!.args;
    expect(args[args.indexOf("--resume") + 1]).toBe(session);
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    done();
  });

  test("a failed answer is reported", async () => {
    const { driver, done } = driverFor(
      [{ type: "result", subtype: "error_during_execution", is_error: true }],
      1,
    );
    const { calls, input } = recorder();
    await driver.run({
      ...input,
      config: config(),
      entries: [],
      text: "Hi",
      signal: new AbortController().signal,
      read,
    });
    expect(calls.filter(([name]) => name === "error")).toHaveLength(1);
    done();
  });

  test("stopping kills the run and keeps its session, without an error", async () => {
    const { driver, runs, done } = driverFor([TOOL_ROUND[0], "hang"]);
    const { calls, input } = recorder();
    const running = driver.run({
      ...input,
      config: config(),
      entries: [],
      text: "Hi",
      signal: new AbortController().signal,
      read,
    });
    while (!runs.length) await new Promise((resolve) => setTimeout(resolve, 1));
    await driver.stop();
    const entries = await running;
    expect(runs[0]!.killed).toBe(true);
    expect(entries).toEqual([
      { type: "ranger-claude", session: expect.any(String) },
    ]);
    expect(calls.some(([name]) => name === "error")).toBe(false);
    done();
  });

  test("refuses an unknown model and a foreign context", async () => {
    const { driver, done } = driverFor(TOOL_ROUND);
    const { input } = recorder();
    const base = {
      ...input,
      text: "Hi",
      signal: new AbortController().signal,
      read,
    };
    await expect(
      driver.run({ ...base, config: config({ model: "gpt" }), entries: [] }),
    ).rejects.toThrow("Model unavailable");
    await expect(
      driver.run({
        ...base,
        config: config(),
        entries: [{ type: "ranger-durable", id: "x" }],
      }),
    ).rejects.toThrow("Invalid Claude Code context");
    done();
  });
});
