import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { CONNECTION_CHANGED_DURING_REQUEST } from "../connections/protocol";
import type { AgentSessionFileAccess } from "./session-file-access";
import { validateCodexSessionId } from "./session-file-access";
import type { HerdrCall } from "./session-types";
import { isRecord, stringValue } from "./session-utils";

const PREVIEW_LIFETIME_MS = 5 * 60_000;
// shortcut: metadata is bounded to 1 MiB; use streaming parsing if Codex exceeds it.
const METADATA_LIMIT = 1024 * 1024;

export function createCodexSessionLinker(
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess,
) {
  const pending = new Map<
    string,
    {
      token: string;
      expires: number;
      sessionId: string;
      path: string;
      identity?: string;
      occupant: string;
      session: string;
    }
  >();

  async function snapshot(paneId: string) {
    if (!paneId) throw new Error("Session linking requires pane_id.");
    const [agentResult, processResult] = await Promise.all([
      herdrCall("agent.get", { target: paneId }),
      herdrCall("pane.process_info", { pane_id: paneId }),
    ]);
    const agent = isRecord(agentResult) && agentResult.agent;
    const process = isRecord(processResult) && processResult.process_info;
    if (
      !isRecord(agent) ||
      agent.agent !== "codex" ||
      !stringValue(agent.terminal_id) ||
      !isRecord(process) ||
      !Array.isArray(process.foreground_processes)
    )
      throw new Error(
        "This pane is no longer running Codex. Refresh and try again.",
      );
    const foreground = process.foreground_processes.filter(isRecord);
    if (
      !foreground.some(
        (item) =>
          ["codex", "codex.exe"].includes(basename(stringValue(item.name))) &&
          Number.isSafeInteger(item.pid) &&
          Number(item.pid) > 0,
      )
    )
      throw new Error("Codex must be in the foreground to link its session.");
    return {
      occupant: JSON.stringify([
        agent.terminal_id,
        process.foreground_process_group_id,
        foreground.map((item) => [item.pid, item.name]).sort(),
      ]),
      session: JSON.stringify(agent.agent_session ?? null),
    };
  }

  async function metadata(sessionId: string) {
    const file = await files.findCodexSessionById(sessionId);
    if (!file)
      throw new Error(
        "No transcript was found for this session ID on the selected connection.",
      );
    const text = new TextDecoder().decode(
      await files.readPrefix(file.path, METADATA_LIMIT),
    );
    let record: unknown;
    try {
      record = JSON.parse(text.split("\n", 1)[0] ?? "");
    } catch {
      throw new Error(
        "The Codex transcript metadata is incomplete, unreadable, or exceeds the 1 MiB preview limit.",
      );
    }
    if (
      !isRecord(record) ||
      record.type !== "session_meta" ||
      !isRecord(record.payload) ||
      record.payload.id !== sessionId
    )
      throw new Error(
        "The transcript metadata does not match this Codex session ID.",
      );
    return { file, cwd: stringValue(record.payload.cwd) };
  }

  return {
    async preview(params: Record<string, unknown>) {
      const paneId = stringValue(params.pane_id);
      const sessionId = stringValue(params.session_id).trim().toLowerCase();
      validateCodexSessionId(sessionId);
      const before = await snapshot(paneId);
      const { file, cwd } = await metadata(sessionId);
      const after = await snapshot(paneId);
      if (
        before.occupant !== after.occupant ||
        before.session !== after.session
      ) {
        throw new Error(
          "The pane changed while checking the session. Try again.",
        );
      }
      for (const [key, value] of pending) {
        if (value.expires <= Date.now()) pending.delete(key);
      }
      if (pending.size >= 128) pending.delete(pending.keys().next().value!);
      const token = randomUUID();
      pending.set(paneId, {
        token,
        expires: Date.now() + PREVIEW_LIFETIME_MS,
        sessionId,
        path: file.path,
        identity: file.identity,
        ...after,
      });
      return {
        token,
        session_id: sessionId,
        path: file.path,
        cwd,
        updated_at: new Date(file.mtimeMs).toISOString(),
      };
    },
    async link(
      params: Record<string, unknown>,
      requestIsCurrent: () => boolean = () => true,
    ) {
      const beforeSend = () => {
        if (!requestIsCurrent())
          throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
      };
      const paneId = stringValue(params.pane_id);
      const preview = pending.get(paneId);
      if (
        !preview ||
        preview.token !== params.token ||
        preview.expires <= Date.now()
      ) {
        throw new Error("Session preview expired. Check the session ID again.");
      }
      pending.delete(paneId);
      const { file } = await metadata(preview.sessionId);
      const current = await snapshot(paneId);
      if (
        current.occupant !== preview.occupant ||
        current.session !== preview.session ||
        file.path !== preview.path ||
        file.identity !== preview.identity
      )
        throw new Error(
          "The pane or transcript changed. Check the session ID again.",
        );
      // shortcut: Herdr has no atomic process guard; a switch during this RPC still requires relinking.
      beforeSend();
      await herdrCall(
        "pane.report_agent_session",
        {
          pane_id: paneId,
          source: "herdr:codex",
          agent: "codex",
          agent_session_id: preview.sessionId,
        },
        undefined,
        beforeSend,
      );
      const result = await herdrCall("agent.get", { target: paneId });
      const agent = isRecord(result) && result.agent;
      const session = isRecord(agent) && agent.agent_session;
      if (
        !isRecord(session) ||
        session.kind !== "id" ||
        session.value !== preview.sessionId
      ) {
        throw new Error(
          "Herdr did not retain the session link. Refresh and try again.",
        );
      }
      return { session_id: preview.sessionId };
    },
  };
}
