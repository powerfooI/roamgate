import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";
import type { SessionFile } from "./session-types";

const SESSION_FILE_TIMEOUT_MS = 15_000;

type RunBinaryProcessWithTimeout = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

export type AgentSessionFileAccess = {
  remote: boolean;
  statFile(path: string): Promise<SessionFile | null>;
  readText(path: string): Promise<string>;
  readPrefix(path: string, byteLimit: number): Promise<Uint8Array>;
  readDownloadBody(path: string): Promise<BodyInit>;
  findPiSessionById(id: string): Promise<SessionFile | null>;
  findCodexSessionById(id: string): Promise<SessionFile | null>;
};

export function validateCodexSessionId(id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Enter a complete Codex session ID.");
  }
}

export function codexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  if (!configured) return join(homedir(), ".codex");
  if (configured === "~") return homedir();
  return configured.startsWith("~/")
    ? join(homedir(), configured.slice(2))
    : resolve(configured);
}

async function findLocalCodexSession(id: string) {
  validateCodexSessionId(id);
  let found: string | null = null;
  for (const directory of ["sessions", "archived_sessions"]) {
    const root = join(codexHome(), directory);
    try {
      for await (const path of new Bun.Glob("**/*.jsonl").scan({
        cwd: root,
        absolute: true,
        onlyFiles: true,
      })) {
        if (!basename(path).endsWith(`-${id}.jsonl`)) continue;
        if (found)
          throw new Error("Multiple transcripts match this Codex session ID.");
        found = path;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found ? localSessionFile(found) : null;
}

async function localSessionFile(path: string): Promise<SessionFile | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return {
      path,
      mtimeMs: info.mtimeMs,
      size: info.size,
      identity: `${info.dev}:${info.ino}`,
      changeToken: String(info.ctimeMs),
    };
  } catch {
    return null;
  }
}

export const localAgentSessionFiles: AgentSessionFileAccess = {
  remote: false,
  statFile: localSessionFile,
  readText: (path) => Bun.file(path).text(),
  async readPrefix(path, byteLimit) {
    return new Uint8Array(
      await Bun.file(path).slice(0, byteLimit).arrayBuffer(),
    );
  },
  async readDownloadBody(path) {
    return Bun.file(path);
  },
  async findPiSessionById() {
    return null;
  },
  findCodexSessionById: findLocalCodexSession,
};

function parseRemoteFileMetadata(stdout: string): SessionFile | null {
  const [rawSize, rawMtime, rawPath, identity, changeToken] = stdout
    .trim()
    .split("\t");
  if (!rawPath) return null;
  const path = Buffer.from(rawPath, "base64").toString("utf8");
  if (!path) return null;
  const size = Number(rawSize);
  const mtimeSeconds = Number(rawMtime);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeSeconds)) return null;
  return { path, size, mtimeMs: mtimeSeconds * 1000, identity, changeToken };
}

export function createAgentSessionFileAccess(args: {
  sshHost?: string;
  runBinaryProcessWithTimeout: RunBinaryProcessWithTimeout;
  shQuote: (value: string) => string;
}): AgentSessionFileAccess {
  if (!args.sshHost) return localAgentSessionFiles;
  const host = args.sshHost;

  async function runRemote(command: string) {
    const result = await args.runBinaryProcessWithTimeout(
      sshCommandArgv(
        host,
        `bash -lc ${args.shQuote(command)}`,
        [],
        "agent.session.read",
      ),
      SESSION_FILE_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(
        (
          result.stderr ||
          result.stdout.toString("utf8") ||
          `remote session command exited ${result.code}`
        )
          .trim()
          .slice(0, 1000),
      );
    }
    return result.stdout;
  }

  async function statFile(path: string) {
    const command = `
set -eu
path=${args.shQuote(path)}
[ -f "$path" ] || exit 44
size="$(stat -c %s "$path" 2>/dev/null || stat -f %z "$path")"
mtime="$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path")"
path64="$(printf '%s' "$path" | base64 | tr -d '\\n')"
identity="$(stat -c '%d:%i' "$path" 2>/dev/null || stat -f '%d:%i' "$path")"
change="$(stat -c '%y:%z' "$path" 2>/dev/null || stat -f '%Fm:%Fc' "$path")"
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$size" "$mtime" "$path64" "$identity" "$change"
`;
    const result = await args.runBinaryProcessWithTimeout(
      sshCommandArgv(
        host,
        `bash -lc ${args.shQuote(command)}`,
        [],
        "agent.session.stat",
      ),
      SESSION_FILE_TIMEOUT_MS,
    );
    if (result.code === 44) return null;
    if (result.code !== 0) {
      throw new Error(
        (
          result.stderr ||
          result.stdout.toString("utf8") ||
          `remote session stat exited ${result.code}`
        )
          .trim()
          .slice(0, 1000),
      );
    }
    return parseRemoteFileMetadata(result.stdout.toString("utf8"));
  }

  return {
    remote: true,
    statFile,
    async findCodexSessionById(id) {
      validateCodexSessionId(id);
      const script = `
import os, sys
from pathlib import Path
root = Path(os.path.expanduser(os.environ.get("CODEX_HOME") or "~/.codex"))
matches = []
for directory in ("sessions", "archived_sessions"):
    matches.extend((root / directory).glob("**/*-" + sys.argv[1] + ".jsonl"))
matches = [path for path in matches if path.is_file()]
if len(matches) > 1:
    sys.exit("Multiple transcripts match this Codex session ID.")
if matches:
    print(matches[0].resolve())
`;
      const path = (
        await runRemote(
          `python3 -c ${args.shQuote(script)} ${args.shQuote(id)}`,
        )
      )
        .toString("utf8")
        .trim();
      return path ? statFile(path) : null;
    },
    async readText(path) {
      return (await runRemote(`set -eu\ncat ${args.shQuote(path)}`)).toString(
        "utf8",
      );
    },
    async readPrefix(path, byteLimit) {
      return runRemote(
        `set -eu\nhead -c ${Math.max(1, Math.floor(byteLimit))} ${args.shQuote(path)}`,
      );
    },
    async readDownloadBody(path) {
      const bytes = await runRemote(`set -eu\ncat ${args.shQuote(path)}`);
      return Uint8Array.from(bytes).buffer;
    },
    async findPiSessionById(id) {
      const command = `
set -eu
id=${args.shQuote(id)}
root="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$root" ] || exit 44
latest=""
latest_mtime=0
while IFS= read -r -d '' candidate; do
  mtime="$(stat -c %Y "$candidate" 2>/dev/null || stat -f %m "$candidate")"
  if [ "$mtime" -ge "$latest_mtime" ]; then
    latest="$candidate"
    latest_mtime="$mtime"
  fi
done < <(find "$root" -type f \\( -name "$id.jsonl" -o -name "*_$id.jsonl" \\) -print0)
[ -n "$latest" ] || exit 44
size="$(stat -c %s "$latest" 2>/dev/null || stat -f %z "$latest")"
path64="$(printf '%s' "$latest" | base64 | tr -d '\\n')"
printf '%s\\t%s\\t%s\\n' "$size" "$latest_mtime" "$path64"
`;
      const result = await args.runBinaryProcessWithTimeout(
        sshCommandArgv(
          host,
          `bash -lc ${args.shQuote(command)}`,
          [],
          "agent.session.find",
        ),
        SESSION_FILE_TIMEOUT_MS,
      );
      if (result.code === 44) return null;
      if (result.code !== 0) {
        throw new Error(
          (
            result.stderr ||
            result.stdout.toString("utf8") ||
            `remote Pi session search exited ${result.code}`
          )
            .trim()
            .slice(0, 1000),
        );
      }
      return parseRemoteFileMetadata(result.stdout.toString("utf8"));
    },
  };
}
