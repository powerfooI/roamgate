export type ComposerCommand = {
  name: string;
  description: string;
  arguments?: string;
};

// Built-in input-assistance catalogs, not live capability lists or validators.
// Availability depends on agent version/configuration. Argument hints are
// display-only; plugins and unlisted commands remain freely editable/sendable.
const catalogs: Record<string, readonly ComposerCommand[]> = {
  // https://code.claude.com/docs/en/commands
  claude: [
    { name: "/help", description: "Show help and available commands" },
    {
      name: "/compact",
      description: "Summarize the conversation to free context",
      arguments: "[instructions]",
    },
    {
      name: "/clear",
      description: "Start a new conversation with empty context",
      arguments: "[name]",
    },
    {
      name: "/model",
      description: "Choose or switch the AI model",
      arguments: "[model]",
    },
    {
      name: "/resume",
      description: "Resume a conversation or open the session picker",
      arguments: "[session]",
    },
    {
      name: "/status",
      description: "Show version, model, account, and connectivity",
    },
    { name: "/config", description: "Open settings and preferences" },
    {
      name: "/add-dir",
      description: "Add a working directory for session file access",
      arguments: "<path>",
    },
    {
      name: "/context",
      description: "Show context usage and optimization tips",
    },
    {
      name: "/usage",
      description: "Show session cost, usage limits, and activity",
    },
    { name: "/memory", description: "Edit CLAUDE.md and manage auto memory" },
    { name: "/permissions", description: "Manage tool permission rules" },
    { name: "/mcp", description: "Manage MCP servers and authentication" },
    { name: "/skills", description: "List and manage available skills" },
    { name: "/plugin", description: "Browse and manage plugins" },
    { name: "/reload-plugins", description: "Reload active plugins" },
    {
      name: "/reload-skills",
      description: "Reload skill and command directories",
    },
    { name: "/init", description: "Create a CLAUDE.md project guide" },
    {
      name: "/plan",
      description: "Enter plan mode before making changes",
      arguments: "[description]",
    },
    { name: "/review", description: "Review changes for correctness issues" },
    { name: "/diff", description: "Review working-tree changes" },
    {
      name: "/rewind",
      description: "Rewind conversation or code to an earlier point",
    },
    {
      name: "/rename",
      description: "Rename the current session",
      arguments: "[name]",
    },
    {
      name: "/copy",
      description: "Copy an assistant response to the clipboard",
    },
    {
      name: "/export",
      description: "Export the conversation as plain text",
      arguments: "[filename]",
    },
    { name: "/hooks", description: "View tool-event hook configurations" },
    { name: "/tasks", description: "View and manage background work" },
    { name: "/doctor", description: "Diagnose installation and project setup" },
    { name: "/theme", description: "Choose the terminal color theme" },
    { name: "/keybindings", description: "Open keyboard shortcut settings" },
    { name: "/release-notes", description: "Browse release notes" },
    { name: "/login", description: "Sign in to your Anthropic account" },
    { name: "/logout", description: "Sign out of your Anthropic account" },
    {
      name: "/btw",
      description: "Ask a side question outside the main conversation",
      arguments: "[question]",
    },
    {
      name: "/branch",
      description: "Branch the conversation and switch to the new branch",
      arguments: "[name]",
    },
    { name: "/effort", description: "Choose the model reasoning effort" },
    {
      name: "/exit",
      description: "Exit the CLI or detach a background session",
    },
  ],
  // https://github.com/openai/codex/blob/main/codex-rs/tui/src/slash_command.rs
  codex: [
    { name: "/model", description: "Choose the model and reasoning effort" },
    { name: "/new", description: "Start a new chat" },
    { name: "/resume", description: "Resume a saved chat" },
    {
      name: "/compact",
      description: "Summarize the conversation to free context",
    },
    { name: "/diff", description: "Show git diff, including untracked files" },
    {
      name: "/status",
      description: "Show session configuration and token usage",
    },
    { name: "/permissions", description: "Choose what Codex is allowed to do" },
    { name: "/review", description: "Review current changes and find issues" },
    { name: "/plan", description: "Switch to plan mode" },
    { name: "/init", description: "Create an AGENTS.md project guide" },
    { name: "/skills", description: "Browse available skills" },
    { name: "/mcp", description: "List configured MCP servers and tools" },
    { name: "/plugins", description: "Browse plugins" },
    { name: "/fork", description: "Fork the current conversation" },
    {
      name: "/rename",
      description: "Rename the current conversation",
      arguments: "[name]",
    },
    { name: "/copy", description: "Copy the last response or part of it" },
    { name: "/export", description: "Export the conversation as Markdown" },
    { name: "/mention", description: "Choose a file to mention" },
    { name: "/ps", description: "List background terminals" },
    { name: "/stop", description: "Stop all background terminals" },
    { name: "/clear", description: "Clear the terminal and start a new chat" },
    { name: "/theme", description: "Choose a syntax highlighting theme" },
    { name: "/statusline", description: "Configure status-line items" },
    {
      name: "/debug-config",
      description: "Show configuration layers and sources",
    },
    { name: "/feedback", description: "Send feedback and logs to maintainers" },
    { name: "/logout", description: "Sign out of Codex" },
    {
      name: "/cd",
      description: "Change the working directory",
      arguments: "<path>",
    },
    { name: "/pwd", description: "Show the current working directory" },
    { name: "/usage", description: "View account usage and limits" },
    { name: "/hooks", description: "View and manage lifecycle hooks" },
    { name: "/quit", description: "Exit Codex" },
  ],
  // https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/slash-commands.md
  pi: [
    {
      name: "/model",
      description: "Select a model",
      arguments: "[provider/model]",
    },
    { name: "/settings", description: "Open settings" },
    { name: "/new", description: "Start a new session" },
    { name: "/resume", description: "Switch to another saved session" },
    {
      name: "/compact",
      description: "Compact the current context",
      arguments: "[instructions]",
    },
    {
      name: "/session",
      description: "Show session information and statistics",
    },
    { name: "/tree", description: "Navigate the session tree" },
    {
      name: "/thinking",
      description: "Set the model thinking level",
      arguments: "[level]",
    },
    {
      name: "/scoped-models",
      description: "Choose models for interactive cycling",
    },
    {
      name: "/login",
      description: "Add provider authentication",
      arguments: "[provider]",
    },
    { name: "/logout", description: "Remove provider authentication" },
    {
      name: "/llama",
      description: "Manage models on the configured llama.cpp router",
    },
    {
      name: "/name",
      description: "Show or set the session display name",
      arguments: "[name]",
    },
    {
      name: "/fork",
      description: "Start a new session from an earlier message",
    },
    {
      name: "/clone",
      description: "Duplicate the session at its current position",
    },
    {
      name: "/import",
      description: "Import and resume a JSONL session",
      arguments: "<path>",
    },
    { name: "/copy", description: "Copy the last assistant message" },
    {
      name: "/export",
      description: "Export the session as HTML or JSONL",
      arguments: "[path]",
    },
    {
      name: "/share",
      description: "Upload the session and return a viewer link",
    },
    {
      name: "/bug",
      description: "Prepare a private bug report for Pi developers",
      arguments: "[description]",
    },
    { name: "/trust", description: "Save a project trust decision" },
    {
      name: "/reload",
      description: "Reload extensions, skills, themes, and context",
    },
    { name: "/hotkeys", description: "Show active keyboard shortcuts" },
    { name: "/changelog", description: "Show changelog entries" },
    { name: "/quit", description: "Exit Pi" },
  ],
  // https://moonshotai.github.io/kimi-cli/en/reference/slash-commands.html
  kimi: [
    {
      name: "/help",
      description: "Show shortcuts, commands, and loaded skills",
    },
    { name: "/model", description: "Switch models and thinking mode" },
    { name: "/new", description: "Create and switch to a new session" },
    { name: "/sessions", description: "List and switch saved sessions" },
    { name: "/clear", description: "Clear the current session context" },
    {
      name: "/compact",
      description: "Compact context to reduce token usage",
      arguments: "[instructions]",
    },
    { name: "/usage", description: "Show Kimi Code API usage and quota" },
    { name: "/version", description: "Show the Kimi Code CLI version" },
    { name: "/changelog", description: "Show recent release notes" },
    {
      name: "/feedback",
      description: "Submit feedback to Kimi Code maintainers",
    },
    { name: "/login", description: "Sign in or configure an API platform" },
    { name: "/logout", description: "Sign out and remove stored credentials" },
    {
      name: "/editor",
      description: "Choose an external editor for terminal input",
      arguments: "[command]",
    },
    {
      name: "/theme",
      description: "Show or change the terminal theme",
      arguments: "[dark|light]",
    },
    { name: "/reload", description: "Reload the configuration file" },
    {
      name: "/debug",
      description: "Inspect messages, tokens, and checkpoints",
    },
    { name: "/mcp", description: "Show connected MCP servers and tools" },
    { name: "/hooks", description: "Show configured lifecycle hooks" },
    {
      name: "/title",
      description: "Show or set the current session title",
      arguments: "[text]",
    },
    {
      name: "/undo",
      description: "Fork from an earlier turn and edit its prompt",
    },
    { name: "/fork", description: "Copy the conversation into a new session" },
    {
      name: "/export",
      description: "Export the session to a Markdown file",
      arguments: "[path]",
    },
    {
      name: "/import",
      description: "Import reference context from a file or session",
      arguments: "<file_path|session_id>",
    },
    {
      name: "/add-dir",
      description: "Add or list extra workspace directories",
      arguments: "[path]",
    },
    {
      name: "/btw",
      description: "Ask a side question without changing the conversation",
      arguments: "<question>",
    },
    { name: "/init", description: "Analyze the project and create AGENTS.md" },
    {
      name: "/plan",
      description: "Toggle plan mode or inspect the current plan",
      arguments: "[on|off|view|clear]",
    },
    { name: "/task", description: "View and manage background tasks" },
    { name: "/web", description: "Continue the session in Kimi Web UI" },
    { name: "/vis", description: "Open the agent tracing visualizer" },
    { name: "/exit", description: "Exit Kimi Code CLI" },
  ],
  // https://docs.x.ai/build/modes-and-commands
  grok: [
    { name: "/help", description: "Browse commands and keyboard shortcuts" },
    {
      name: "/model",
      description: "Switch the active model",
      arguments: "<name>",
    },
    { name: "/settings", description: "Open settings" },
    { name: "/new", description: "Start a new session" },
    { name: "/resume", description: "Resume a previous session" },
    {
      name: "/sessions",
      description: "Switch, rename, or close active sessions",
    },
    {
      name: "/compact",
      description: "Compact conversation history",
      arguments: "[context]",
    },
    { name: "/context", description: "Show current context usage" },
    { name: "/session-info", description: "Show current session information" },
    {
      name: "/rename",
      description: "Rename the current session",
      arguments: "<title>",
    },
    { name: "/fork", description: "Branch the session into a peer agent" },
    { name: "/rewind", description: "Rewind to a previous turn" },
    {
      name: "/copy",
      description: "Copy the last or Nth-latest response",
      arguments: "[N]",
    },
    {
      name: "/export",
      description: "Export the conversation to a file or clipboard",
    },
    { name: "/share", description: "Share the current session via a URL" },
    { name: "/find", description: "Search conversation scrollback" },
    {
      name: "/transcript",
      description: "View the full transcript in your pager",
    },
    {
      name: "/effort",
      description: "Set the current model's reasoning effort",
    },
    {
      name: "/plan",
      description: "Enter plan mode",
      arguments: "[description]",
    },
    { name: "/view-plan", description: "View the current plan" },
    {
      name: "/btw",
      description: "Ask a side question without interrupting",
      arguments: "<question>",
    },
    {
      name: "/tasks",
      description: "List background tasks, subagents, and schedules",
    },
    { name: "/queue", description: "List queued prompts" },
    { name: "/dashboard", description: "Open the agent dashboard" },
    {
      name: "/theme",
      description: "Switch the color theme",
      arguments: "[name]",
    },
    { name: "/config-agents", description: "Manage agent definitions" },
    { name: "/plugins", description: "Open the plugins manager" },
    { name: "/skills", description: "Browse available skills" },
    { name: "/mcps", description: "Manage MCP servers and tools" },
    { name: "/hooks", description: "Browse hooks" },
    { name: "/marketplace", description: "Browse extension marketplaces" },
    {
      name: "/create-workflow",
      description: "Create and save a workflow",
      arguments: "[description]",
    },
    {
      name: "/workflow",
      description: "Launch or manage a saved workflow",
      arguments: "<name> [args]",
    },
    { name: "/workflows", description: "Open the workflow run dashboard" },
    { name: "/usage", description: "View credit usage and billing" },
    {
      name: "/privacy",
      description: "Manage privacy and data-retention settings",
    },
    {
      name: "/feedback",
      description: "Send feedback about the current session",
    },
    { name: "/release-notes", description: "View release notes" },
    { name: "/login", description: "Sign in to Grok Build" },
    { name: "/logout", description: "Sign out of the current account" },
    { name: "/quit", description: "Exit Grok Build" },
  ],
  // https://antigravity.google/docs/cli/reference
  agy: [
    { name: "/help", description: "Show commands and keyboard shortcuts" },
    { name: "/model", description: "Choose the reasoning model" },
    { name: "/config", description: "Open the settings editor" },
    {
      name: "/clear",
      description: "Clear the terminal and reset conversation context",
    },
    { name: "/resume", description: "Open the conversation picker" },
    {
      name: "/fork",
      description: "Clone the conversation into a parallel session",
    },
    { name: "/rewind", description: "Roll back to an earlier message" },
    {
      name: "/rename",
      description: "Rename the current session",
      arguments: "<name>",
    },
    { name: "/context", description: "Show context usage" },
    { name: "/planning", description: "Enable multi-turn planning mode" },
    { name: "/fast", description: "Enable fast mode without reasoning plans" },
    { name: "/diff", description: "Review changes, turns, and commits" },
    { name: "/artifact", description: "Open the artifact review panel" },
    {
      name: "/agents",
      description: "Manage agents and monitor background subagents",
    },
    { name: "/tasks", description: "Monitor background shell tasks" },
    { name: "/mcp", description: "Manage MCP servers" },
    { name: "/skills", description: "Browse loaded local and global skills" },
    { name: "/hooks", description: "Browse active script hooks" },
    { name: "/plugin", description: "Browse and manage plugins" },
    { name: "/permissions", description: "Manage tool permissions" },
    { name: "/keybindings", description: "Edit keyboard shortcuts" },
    { name: "/statusline", description: "Customize the status bar" },
    {
      name: "/title",
      description: "Configure terminal window title updates",
      arguments: "[on|off]",
    },
    {
      name: "/add-dir",
      description: "Add a directory to the active workspace",
      arguments: "<path>",
    },
    {
      name: "/open",
      description: "Open a path in the system editor",
      arguments: "<path>",
    },
    {
      name: "/btw",
      description: "Ask a side question without interrupting",
      arguments: "<query>",
    },
    { name: "/copy", description: "Copy the last agent response" },
    { name: "/usage", description: "Show model quota usage" },
    { name: "/feedback", description: "Open the feedback panel" },
    {
      name: "/logout",
      description: "Sign out and remove authentication tokens",
    },
    { name: "/exit", description: "Exit Antigravity CLI" },
  ],
};

const aliases = new Map([
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["claude code", "claude"],
  ["codex", "codex"],
  ["codex-cli", "codex"],
  ["codex cli", "codex"],
  ["pi", "pi"],
  ["pi-agent", "pi"],
  ["pi-coding-agent", "pi"],
  ["kimi", "kimi"],
  ["kimi-code", "kimi"],
  ["kimi code", "kimi"],
  ["kimi-cli", "kimi"],
  ["grok", "grok"],
  ["grok-build", "grok"],
  ["grok build", "grok"],
  ["agy", "agy"],
  ["antigravity", "agy"],
  ["antigravity-cli", "agy"],
  ["antigravity cli", "agy"],
]);

export function terminalComposerCommands(
  agent?: string,
): readonly ComposerCommand[] {
  const identity = aliases.get(agent?.trim().toLowerCase() ?? "");
  return identity ? catalogs[identity] : [];
}

export function filterComposerCommands(
  commands: readonly ComposerCommand[],
  query: string,
): readonly ComposerCommand[] {
  const prefix = query.trim().toLowerCase().replace(/^\//, "");
  return commands.filter((command) => command.name.slice(1).startsWith(prefix));
}

/** Only complete the first token, and only while the selection is inside it. */
export function composerCommandPrefix(
  text: string,
  start: number,
  end = start,
): string | null {
  const token = /^\/[^\s]*/.exec(text)?.[0];
  return token && start > 0 && start <= token.length && end <= token.length
    ? token
    : null;
}

/** Replace only the leading token; preserve whitespace, arguments, and caret offsets. */
export function completeComposerCommand(
  text: string,
  command: ComposerCommand,
  start: number,
  end = start,
): { text: string; start: number; end: number } | null {
  const token = /^\/[^\s]*/.exec(text)?.[0];
  if (!token) return null;
  const suffix = text.slice(token.length);
  const next = command.name + (suffix || " ");
  const position = (offset: number) =>
    Math.min(
      next.length,
      offset > token.length
        ? offset + command.name.length - token.length
        : command.name.length + (suffix ? 0 : 1),
    );
  return { text: next, start: position(start), end: position(end) };
}
