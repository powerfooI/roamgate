import type { AgentSessionFileAccess } from "./session-file-access";
import {
  type AgentSessionResolverContext,
  resolveAgentSessionInfo,
} from "./session-resolver";
import { isRecord, normalizeAgentName } from "./session-utils";

/**
 * Over SSH, a pane's activity time is reused this long while its agent's
 * state stays: Herdr's agent list is polled every few seconds, and a stat
 * each time for each agent kept the host's session slots busy for an
 * order only idle agents need.
 */
export const REMOTE_ACTIVITY_REUSE_MS = 30_000;
const remoteActivity = new WeakMap<
  AgentSessionResolverContext,
  Map<string, { at: number; time: number | null }>
>();

/** Add durable activity metadata without parsing or downloading transcripts. */
export async function enrichAgentActivity(
  result: unknown,
  files: AgentSessionFileAccess,
  context: AgentSessionResolverContext,
  timeoutMs = 1500,
) {
  if (!isRecord(result) || !Array.isArray(result.agents)) return result;
  const agents: unknown[] = [...result.agents];
  const source = result.agents;
  let next = 0;
  let expired = false;
  // Bound filesystem/SSH work when many agents are open.
  const pending = Promise.all(
    Array.from({ length: Math.min(4, source.length) }, async () => {
      while (!expired && next < source.length) {
        const index = next++;
        const agent: unknown = source[index];
        agents[index] = agent;
        if (!isRecord(agent) || typeof agent.pane_id !== "string") continue;
        const session = agent.agent_session;
        if (!isRecord(session)) continue;
        const name = normalizeAgentName(String(agent.agent ?? session.agent));
        // ID-based resolvers (except Pi and Codex) search local directories. Never use
        // this host's sessions as activity evidence for a remote connection.
        if (
          files.remote &&
          (name === "grok" ||
            name === "agy" ||
            (session.kind !== "path" && name !== "pi" && name !== "codex"))
        )
          continue;
        const reuse = files.remote ? remoteActivityFor(context) : null;
        const key = JSON.stringify([
          agent.pane_id,
          session.kind,
          session.value,
          agent.agent_status,
          agent.state_change_seq,
        ]);
        const known = reuse?.get(key);
        if (known && Date.now() - known.at < REMOTE_ACTIVITY_REUSE_MS) {
          if (known.time !== null)
            agents[index] = { ...agent, last_activity_at: known.time };
          continue;
        }
        try {
          const resolved = await resolveAgentSessionInfo(
            { pane_id: agent.pane_id },
            agent,
            files,
            context,
          );
          const time = resolved.file?.mtimeMs;
          const usable =
            typeof time === "number" && Number.isFinite(time) && time > 0;
          if (usable) agents[index] = { ...agent, last_activity_at: time };
          reuse?.set(key, { at: Date.now(), time: usable ? time : null });
        } catch {
          // Missing, unsupported, or unreadable sessions must not hide agents.
        }
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // In-flight stats may finish after the deadline. Return a detached snapshot
  // and stop scheduling more work so optional metadata cannot block navigation.
  return { ...result, agents: [...agents] };
}

function remoteActivityFor(context: AgentSessionResolverContext) {
  let known = remoteActivity.get(context);
  if (!known || known.size > 1000) {
    known = new Map();
    remoteActivity.set(context, known);
  }
  return known;
}
