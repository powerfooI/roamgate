import type { AgentTaskSession } from "../../shared/agentTasks";
import type { ConnectionClient } from "./api";
import {
  defaultAgentLaunchCommand,
  readAgentLaunchCommand,
} from "./agentLauncher";
import { sendTerminalComposerText } from "./terminalComposer";

export const AGENT_START_TIMEOUT_MS = 60_000;
const POLL_MS = 1000;

export type StartAgentTaskDeps = {
  client: Pick<ConnectionClient, "call" | "connectionId" | "isCurrent">;
  /** Creates a tab in the workspace; resolves to Herdr's tab.create reply. */
  createTab(workspaceId: string): Promise<unknown>;
  /**
   * Records the session on the task. Runs once the agent is ready and before
   * the prompt is sent, so a failed link can never lead to a second send.
   */
  link?(session: AgentTaskSession): Promise<void>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type StartAgentTaskInput = {
  workspaceId: string;
  agent: string;
  /** The integration's default command (integration.list). */
  agentCommand: string;
  prompt: string;
};

function sessionFromCreate(result: unknown): AgentTaskSession | null {
  const reply = (result ?? {}) as {
    root_pane?: { pane_id?: unknown; terminal_id?: unknown; tab_id?: unknown };
    tab?: { tab_id?: unknown };
  };
  const pane = reply.root_pane;
  const tabId = pane?.tab_id ?? reply.tab?.tab_id;
  if (
    typeof pane?.pane_id !== "string" ||
    typeof pane.terminal_id !== "string" ||
    typeof tabId !== "string"
  )
    return null;
  return { tab_id: tabId, pane_id: pane.pane_id, terminal_id: pane.terminal_id };
}

/** Herdr reports the agent ready the same way Ranger's start_agent checks. */
export function agentReady(live: unknown, agent: string): boolean {
  if (!live || typeof live !== "object") return false;
  const value = live as {
    agent?: unknown;
    agent_status?: unknown;
    interactive_ready?: unknown;
  };
  if (value.agent !== agent) return false;
  const status = String(value.agent_status);
  return (
    value.interactive_ready === true ||
    status === "idle" ||
    status === "done" ||
    (agent === "codex" && status === "unknown")
  );
}

/**
 * "Start now" (AC58): a new tab in the workspace, the user's launch command
 * for the agent (the same one the composer's agent launcher runs), then the
 * prompt as the agent's first message once Herdr sees the agent ready. The
 * session is linked before the prompt goes out, and the prompt is sent at
 * most once; a timeout or a failed link throws before sending it (AC59).
 */
export async function startAgentTask(
  deps: StartAgentTaskDeps,
  input: StartAgentTaskInput,
): Promise<AgentTaskSession> {
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const session = sessionFromCreate(await deps.createTab(input.workspaceId));
  if (!session) throw new Error("Roamgate could not open a tab for the agent.");
  const command = readAgentLaunchCommand(
    deps.client.connectionId,
    input.agent,
    defaultAgentLaunchCommand(input.agent, input.agentCommand),
  );
  await sendTerminalComposerText(deps.client, session.pane_id, command, true);
  const deadline = now() + AGENT_START_TIMEOUT_MS;
  while (true) {
    if (!deps.client.isCurrent())
      throw new Error("The connection changed before the agent started.");
    let live: unknown;
    try {
      live = (await deps.client.call("agent.get", { target: session.pane_id }))
        ?.agent;
    } catch (error) {
      // Detection lags the launch; only a missing agent is worth waiting on.
      if (!(error instanceof Error) || !/^agent_not_found/.test(error.message))
        throw error;
    }
    if (agentReady(live, input.agent)) break;
    if ((live as { agent_status?: unknown } | undefined)?.agent_status === "blocked")
      throw new Error(
        "The agent needs input before it is ready. Open its tab to continue.",
      );
    if (now() >= deadline)
      throw new Error(
        `${input.agent} did not start within ${AGENT_START_TIMEOUT_MS / 1000} seconds. Its tab is still open.`,
      );
    await wait(POLL_MS);
  }
  await deps.link?.(session);
  await sendTerminalComposerText(deps.client, session.pane_id, input.prompt, true);
  return session;
}
