import { useEffect, useState } from "react";
import type { AgentCommand } from "../../server/src/agent/session-commands";
import type { Pane } from "./types";
import { useConnectionClient } from "./useConnectionClient";

export type { AgentCommand };

/**
 * Claude Code's own commands. Its transcript records a session's skills and
 * custom commands, not these.
 */
export const CLAUDE_BUILTIN_COMMANDS: AgentCommand[] = [
  { name: "add-dir", description: "Add a working directory" },
  { name: "agents", description: "Manage subagents" },
  { name: "clear", description: "Start a new conversation" },
  {
    name: "compact",
    description: "Summarize the conversation to free context",
  },
  { name: "config", description: "Open the settings" },
  { name: "context", description: "Show what fills the context" },
  { name: "cost", description: "Show this session's cost and duration" },
  { name: "doctor", description: "Check the installation" },
  { name: "exit", description: "Quit Claude Code" },
  { name: "export", description: "Export the conversation" },
  { name: "fast", description: "Toggle fast mode" },
  { name: "help", description: "Show help" },
  { name: "hooks", description: "Manage hooks" },
  { name: "init", description: "Write a CLAUDE.md for this project" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Edit memory files" },
  { name: "model", description: "Choose the model" },
  { name: "permissions", description: "Manage permission rules" },
  { name: "plugin", description: "Manage plugins" },
  { name: "resume", description: "Resume another conversation" },
  { name: "rewind", description: "Go back to an earlier point" },
  { name: "status", description: "Show the version, model and account" },
  { name: "statusline", description: "Set up the status line" },
  { name: "todos", description: "Show the todo list" },
  { name: "usage", description: "Show plan usage" },
  { name: "vim", description: "Toggle Vim editing" },
];

const REFRESH_MS = 60_000;

/** The /commands a Claude pane offers: its own, then the session's. */
export function useAgentCommands(pane: Pane, enabled: boolean): AgentCommand[] {
  const client = useConnectionClient();
  const [session, setSession] = useState<AgentCommand[]>([]);
  const claude = enabled && pane.agent === "claude";
  useEffect(() => {
    if (!claude) {
      setSession([]);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = (await client.call("agent_commands.get", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
        })) as { commands?: AgentCommand[] };
        if (live) setSession(result.commands ?? []);
      } catch {
        // Not readable now: the built-in commands still show.
      }
      if (live) timer = window.setTimeout(load, REFRESH_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    client,
    claude,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  if (!claude) return [];
  const builtin = new Set(CLAUDE_BUILTIN_COMMANDS.map((each) => each.name));
  return [
    ...CLAUDE_BUILTIN_COMMANDS,
    ...session.filter((each) => !builtin.has(each.name)),
  ];
}

/**
 * The commands for a draft that is a command being typed (`/` and a word,
 * nothing else): names starting with it first, then names containing it.
 */
export function matchCommands(
  draft: string,
  commands: AgentCommand[],
  limit = 8,
): AgentCommand[] {
  const typed = /^\/([\w:.-]*)$/.exec(draft);
  if (!typed || !commands.length) return [];
  const query = typed[1]!.toLowerCase();
  const starts = commands.filter((each) =>
    each.name.toLowerCase().startsWith(query),
  );
  const contains = query
    ? commands.filter(
        (each) =>
          !each.name.toLowerCase().startsWith(query) &&
          each.name.toLowerCase().includes(query),
      )
    : [];
  return [...starts, ...contains].slice(0, limit);
}
