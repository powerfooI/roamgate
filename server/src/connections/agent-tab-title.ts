import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrCall } from "../agent/session-types";
import {
  isRecord,
  normalizeAgentName,
  stringValue,
} from "../agent/session-utils";
import { antigravityHome } from "../agent/antigravity-session";
import { sshCommandArgv } from "../bridge/ssh-command";
import { shQuote } from "../utils/process-utils";
import { isGenericTerminalTitle } from "./tab-auto-rename";

type Run = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = Bun.stripANSI(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trim();
  return title ? Array.from(title).slice(0, 160).join("") : null;
}
function annotationTitle(text: string): string | null {
  const match = text.match(/(?:^|\n)\s*title:\s*("(?:\\.|[^"\\])*")/);
  return match ? cleanTitle(JSON.parse(match[1])) : null;
}
export function readHermesSessionTitle(
  path: string,
  id: string,
): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT title FROM sessions WHERE id = ?").get(id) as {
      title: unknown;
    } | null;
    return cleanTitle(row?.title);
  } finally {
    db.close();
  }
}

export function createAgentTabTitleReader(args: {
  herdrCall: HerdrCall;
  readSummary: (params: Record<string, unknown>) => Promise<unknown>;
  sshHost?: string;
  remotePlatform?: string;
  run: Run;
}) {
  async function readBoundTitle(agent: string, id: string) {
    // IDs become annotation filenames and remote command arguments. Never guess a session.
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return null;
    if (args.sshHost) {
      if (args.remotePlatform === "windows") return null;
      const script =
        agent === "hermes"
          ? 'import os, sqlite3, sys, pathlib\np = pathlib.Path(os.path.expanduser("~/.hermes/state.db"))\nwith sqlite3.connect(p.as_uri() + "?mode=ro", uri=True) as db:\n row = db.execute("SELECT title FROM sessions WHERE id = ?", (sys.argv[1],)).fetchone()\n print(row[0] if row and row[0] else "")'
          : 'import os, sys\np = os.path.expanduser("~/.gemini/antigravity-cli/annotations/") + sys.argv[1] + ".pbtxt"\nwith open(p, encoding="utf-8") as f:\n print(f.read())';
      const result = await args.run(
        sshCommandArgv(
          args.sshHost,
          `python3 -c ${shQuote(script)} ${shQuote(id)}`,
        ),
        3000,
      );
      if (result.code !== 0) return null;
      const text = result.stdout.toString("utf8");
      return agent === "hermes" ? cleanTitle(text) : annotationTitle(text);
    }
    return agent === "hermes"
      ? readHermesSessionTitle(join(homedir(), ".hermes", "state.db"), id)
      : annotationTitle(
          await Bun.file(
            join(antigravityHome(), "annotations", `${id}.pbtxt`),
          ).text(),
        );
  }
  return async (paneId: string): Promise<string | null> => {
    const result = await args.herdrCall("agent.get", { target: paneId });
    if (!isRecord(result) || !isRecord(result.agent)) return null;
    const info = result.agent;
    const agent = normalizeAgentName(stringValue(info.agent));
    if (!agent) return null;
    const session = isRecord(info.agent_session) ? info.agent_session : null;
    let title: string | null = null;
    if (
      session &&
      (!session.agent ||
        normalizeAgentName(stringValue(session.agent)) === agent)
    ) {
      if (agent === "claude") {
        const summary = await args
          .readSummary({ pane_id: paneId })
          .catch(() => null);
        if (
          isRecord(summary) &&
          isRecord(summary.session) &&
          summary.session.kind === session.kind &&
          summary.session.value === session.value
        )
          title = cleanTitle(summary.title);
      } else if (
        (agent === "hermes" || agent === "agy") &&
        session.kind === "id"
      ) {
        title = await readBoundTitle(agent, stringValue(session.value)).catch(
          () => null,
        );
      }
    }
    if (!title) {
      const terminal =
        cleanTitle(info.terminal_title_stripped) ??
        cleanTitle(info.terminal_title);
      const stripped = terminal?.replace(/^[\s\u2733*\u2022]+/, "").trim();
      if (stripped && !isGenericTerminalTitle(stripped)) title = stripped;
    }
    if (!title) return null;
    // A new agent/session may have replaced this one while its title was being read.
    const latest = await args.herdrCall("agent.get", { target: paneId });
    if (
      !isRecord(latest) ||
      !isRecord(latest.agent) ||
      latest.agent.agent !== info.agent ||
      JSON.stringify(latest.agent.agent_session) !==
        JSON.stringify(info.agent_session)
    )
      return null;
    return title;
  };
}
