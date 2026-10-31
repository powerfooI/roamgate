import {
  CLAUDE_CODE_PROVIDER,
  ASSISTANT_MAX_TOOL_ARGUMENTS,
  ASSISTANT_MAX_TOOL_OUTPUT,
  type AssistantSnapshot,
} from "../../../shared/assistant";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../agent/session-utils";
import { assertSafeDataPath } from "../config/data-paths";
import { RANGER_MCP_SERVER, type RangerMcp } from "./claude-mcp";
import type { AssistantDriver } from "./pi-driver";
import { AssistantUserError } from "./errors";
import { rangerSystemPrompt, rangerTools } from "./ranger-tools";

export { CLAUDE_CODE_PROVIDER };
/** Claude Code's model aliases: each names its family's latest model. */
const CLAUDE_CODE_MODELS = [
  { id: "opus", label: "Claude Opus" },
  { id: "sonnet", label: "Claude Sonnet" },
  { id: "haiku", label: "Claude Haiku" },
];
/** Ranger's thinking levels Claude Code takes as `--effort`. */
const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const TOOL_PREFIX = `mcp__${RANGER_MCP_SERVER}__`;
const TRUNCATED = "\n[truncated]";

/** The pointer a Claude Code turn leaves in Ranger's saved context. */
export type ClaudeCodePointer = { type: "ranger-claude"; session: string };

export function isClaudeCodePointer(
  entries: readonly unknown[],
): entries is [ClaudeCodePointer] {
  const pointer = entries[0];
  return (
    entries.length === 1 &&
    isRecord(pointer) &&
    pointer.type === "ranger-claude" &&
    typeof pointer.session === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      pointer.session,
    )
  );
}

export type ClaudeCodeProcess = {
  lines: AsyncIterable<string>;
  write(line: string): void;
  /** No more input: the process exits once it has answered. */
  end(): void;
  kill(): void;
  exited: Promise<number>;
};
export type SpawnClaudeCode = (
  args: string[],
  cwd: string,
) => ClaudeCodeProcess;

function spawnClaudeCode(command: string): SpawnClaudeCode {
  return (args, cwd) => {
    const child = Bun.spawn([command, ...args], {
      cwd,
      // A bridge started from a Herdr pane passes that pane's HERDR_*
      // variables on; Claude Code would report its state as that pane's.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("HERDR_"),
        ),
      ),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    async function* lines() {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of child.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          yield buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      }
      if (buffered) yield buffered;
    }
    return {
      lines: lines(),
      write: (line) => {
        child.stdin.write(line);
        child.stdin.flush();
      },
      end: () => void child.stdin.end(),
      kill: () => child.kill(),
      exited: child.exited,
    };
  };
}

function bounded(value: string, max: number) {
  return value.length <= max
    ? value
    : value.slice(0, Math.max(0, max - TRUNCATED.length)) + TRUNCATED;
}

function toolName(name: string) {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

/**
 * Ranger turns on Claude Code: each turn is one `claude -p` run, resumed
 * from the session the last turn left. Claude Code's own tools, hooks,
 * skills and MCP servers are off; Ranger's tools come over MCP for the
 * turn alone (claude-mcp.ts), with Ranger's instructions as the system
 * prompt. It signs in as `claude` does on this machine.
 */
export function createClaudeCodeDriver(options: {
  directory: string;
  mcp: RangerMcp;
  command?: string;
  spawn?: SpawnClaudeCode;
  /** Whether the command can be found; checked for each catalog. */
  available?: () => boolean;
}) {
  const command = options.command ?? "claude";
  const spawn = options.spawn ?? spawnClaudeCode(command);
  const available = options.available ?? (() => Bun.which(command) !== null);
  let active:
    | { stopped: boolean; kill(): void; done: Promise<void> }
    | undefined;

  async function stop() {
    const running = active;
    if (!running) return;
    running.stopped = true;
    running.kill();
    await running.done;
  }

  const driver = {
    catalog(): Pick<AssistantSnapshot, "providers" | "models"> {
      const configured = available();
      return {
        providers: [
          {
            id: CLAUDE_CODE_PROVIDER,
            label: "Claude Code",
            methods: [],
            configured,
          },
        ],
        models: configured
          ? CLAUDE_CODE_MODELS.map((model) => ({
              provider: CLAUDE_CODE_PROVIDER,
              id: model.id,
              label: model.label,
              thinking_levels: [...CLAUDE_CODE_EFFORTS],
              default_thinking_level: "high" as const,
            }))
          : [],
      };
    },

    async run(input: Parameters<AssistantDriver["run"]>[0]) {
      if (active) throw new Error("Ranger is already running");
      const finished = Promise.withResolvers<void>();
      let child: ClaudeCodeProcess | undefined;
      let exited = false;
      let configPath: string | undefined;
      const controller = new AbortController();
      const running = {
        stopped: false,
        kill: () => {
          controller.abort(new Error("Ranger stopped"));
          child?.kill();
        },
        done: finished.promise,
      };
      active = running;
      const abort = () => {
        running.stopped = true;
        controller.abort(new Error("Ranger stopped"));
        child?.kill();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      let lease: ReturnType<RangerMcp["open"]> | undefined;
      // What Ranger keeps for the next turn: the session, once there is one.
      let retained: unknown[] = isClaudeCodePointer(input.entries)
        ? input.entries
        : [];
      try {
        input.signal.throwIfAborted();
        if (input.recover) {
          // A CLI session pointer has no durable MCP result journal. Resending
          // the interrupted prompt could repeat an already executed operation.
          retained = [];
          input.checkpoint?.([]);
          throw new AssistantUserError(
            "The Claude Code turn was interrupted. It was not retried because an operation may already have run. Review the action receipts and send a new question.",
          );
        }
        if (
          !CLAUDE_CODE_MODELS.some((model) => model.id === input.config.model)
        )
          throw new Error("Model unavailable");
        const effort = CLAUDE_CODE_EFFORTS.find(
          (level) => level === input.config.thinking_level,
        );
        const resumed = isClaudeCodePointer(input.entries)
          ? input.entries[0].session
          : undefined;
        if (input.entries.length && !resumed)
          throw new Error("Invalid Claude Code context");
        const session = resumed ?? randomUUID();
        retained = [{ type: "ranger-claude", session }];
        // A private, empty folder: no project instructions or settings.
        const cwd = join(options.directory, "claude");
        // Checks the folder and its parents: no links, nothing but folders.
        assertSafeDataPath(join(cwd, "session"));
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const automatic = input.config.approval_mode === "auto";
        lease = options.mcp.open({
          tools: rangerTools(input, automatic),
          signal: controller.signal,
          sources: (sources) => input.sources?.(sources),
        });
        configPath = join(cwd, `mcp-${randomUUID()}.json`);
        writeFileSync(configPath, lease.config, { flag: "wx", mode: 0o600 });
        const args = [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--model",
          input.config.model,
          ...(effort ? ["--effort", effort] : []),
          ...(resumed ? ["--resume", session] : ["--session-id", session]),
          // Only Ranger's tools: no built-in tools, other MCP servers,
          // skills or hooks.
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          configPath,
          "--allowedTools",
          `mcp__${RANGER_MCP_SERVER}`,
          "--disable-slash-commands",
          "--settings",
          JSON.stringify({ disableAllHooks: true }),
          "--system-prompt",
          `${rangerSystemPrompt(automatic)}\nYour tools are named ${TOOL_PREFIX}<name>; these instructions name them without that prefix.`,
        ];
        // Save the session before it can run a tool, as Pi saves its root.
        input.checkpoint?.(retained);
        child = spawn(args, cwd);
        if (running.stopped) child.kill();
        child.write(
          `${JSON.stringify({
            type: "user",
            message: { role: "user", content: input.text },
          })}\n`,
        );
        child.end();
        const tools = new Map<string, { name: string; arguments?: string }>();
        const thinking: string[] = [];
        let thinkingNow: string | null = null;
        let answered = false;
        let failed = false;
        for await (const line of child.lines) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "stream_event" && isRecord(event.event)) {
            const stream = event.event;
            const block = isRecord(stream.content_block)
              ? stream.content_block
              : undefined;
            const delta = isRecord(stream.delta) ? stream.delta : undefined;
            if (
              stream.type === "content_block_start" &&
              block?.type === "thinking"
            )
              thinkingNow = "";
            else if (
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            )
              input.delta(delta.text);
            else if (
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string" &&
              thinkingNow !== null
            ) {
              thinkingNow += delta.thinking;
              if (thinkingNow.trim())
                input.thinking?.([...thinking, thinkingNow.trim()]);
            } else if (
              stream.type === "content_block_stop" &&
              thinkingNow !== null
            ) {
              if (thinkingNow.trim()) thinking.push(thinkingNow.trim());
              thinkingNow = null;
            }
          } else if (
            (event.type === "assistant" || event.type === "user") &&
            isRecord(event.message) &&
            Array.isArray(event.message.content)
          ) {
            for (const part of event.message.content) {
              if (!isRecord(part)) continue;
              if (part.type === "text" && typeof part.text === "string") {
                if (event.type === "assistant" && part.text)
                  input.message(part.text);
              } else if (
                part.type === "tool_use" &&
                typeof part.id === "string" &&
                typeof part.name === "string"
              ) {
                const tool = {
                  name: toolName(part.name),
                  arguments: isRecord(part.input)
                    ? bounded(
                        JSON.stringify(part.input, null, 2),
                        ASSISTANT_MAX_TOOL_ARGUMENTS,
                      )
                    : undefined,
                };
                tools.set(part.id, tool);
                input.tool(part.id, tool.name, "running", {
                  arguments: tool.arguments,
                });
              } else if (
                part.type === "tool_result" &&
                typeof part.tool_use_id === "string"
              ) {
                const tool = tools.get(part.tool_use_id);
                if (!tool) continue;
                input.tool(
                  part.tool_use_id,
                  tool.name,
                  part.is_error === true ? "failed" : "completed",
                  {
                    arguments: tool.arguments,
                    output: bounded(
                      resultText(part.content),
                      ASSISTANT_MAX_TOOL_OUTPUT,
                    ),
                  },
                );
              }
            }
          } else if (event.type === "result") {
            answered = true;
            failed = event.subtype !== "success" || event.is_error === true;
          }
        }
        const code = await child.exited;
        exited = true;
        if (running.stopped) return retained;
        if (failed || !answered || code !== 0) input.error();
        return retained;
      } catch (error) {
        if (running.stopped) return retained;
        throw error;
      } finally {
        input.signal.removeEventListener("abort", abort);
        controller.abort(new Error("The Ranger turn ended"));
        lease?.close();
        if (child && !exited) {
          child.kill();
          await child.exited.catch(() => {});
        }
        if (configPath) rmSync(configPath, { force: true });
        if (active === running) active = undefined;
        finished.resolve();
      }
    },

    stop,
    /** Recovery refuses to replay a turn without a durable tool journal. */
    dispose: stop,
  };
  return driver;
}
export type ClaudeCodeDriver = ReturnType<typeof createClaudeCodeDriver>;
