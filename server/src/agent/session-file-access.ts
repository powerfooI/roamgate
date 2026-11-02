import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sshReadCommandArgv } from "../bridge/ssh-command";
import type { SessionFile } from "./session-types";

const SESSION_FILE_TIMEOUT_MS = 15_000;
/** A whole transcript can be tens of MB: give a slow link time to send it. */
const SESSION_READ_TIMEOUT_MS = 60_000;
/**
 * Remote transcripts kept so the next read only fetches what was appended,
 * and how much of the end is fetched again to check the rest is unchanged.
 */
const KEPT_TEXT_BYTES = 64 * 1024 * 1024;
const KEPT_TEXT_OVERLAP = 4096;

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
  /**
   * The newest Pi session started in a directory: without Herdr's Pi
   * integration, nothing names the pane's session.
   */
  findPiSessionForCwd(cwd: string): Promise<SessionFile | null>;
  /** A remote Claude transcript by session ID; local ones are found locally. */
  findClaudeSessionById(id: string): Promise<SessionFile | null>;
  /**
   * The transcript a Claude session went on in: the newest one beside it,
   * written since, whose records name its session (a resume or /clear starts a new
   * file Herdr does not learn about). Null when it is still the latest.
   */
  findClaudeSuccessor(path: string, id: string): Promise<string | null>;
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

/**
 * The newest .jsonl beside $f, newer than it, whose sessionId metadata names $id. Paths are read
 * one per line, so a folder with spaces in its name works too.
 */
const CLAUDE_SUCCESSOR_SCRIPT = `
find "$(dirname "$f")" -maxdepth 1 -name '*.jsonl' -newer "$f" -exec grep -l -E -- '"sessionId"[[:space:]]*:[[:space:]]*"'"$id"'"' {} + 2>/dev/null | {
  best=""
  best_mtime=0
  while IFS= read -r g; do
    m="$(stat -c %Y "$g" 2>/dev/null || stat -f %m "$g")"
    if [ "$m" -gt "$best_mtime" ]; then
      best="$g"
      best_mtime="$m"
    fi
  done
  printf %s "$best"
}
`;

/**
 * The directory Pi keeps a working directory's sessions in, under its
 * sessions directory: the path with its slashes as dashes, between "--"
 * (/a/b-c becomes --a-b-c--). Null for a path that would not be safe to
 * name in a shell command.
 */
export function piSessionDirectoryName(cwd: string): string | null {
  if (!cwd.startsWith("/") || /["$`\\\n]/.test(cwd)) return null;
  return `--${cwd.slice(1).replace(/\//g, "-")}--`;
}

function localPiDirectory() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function validClaudeSessionId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
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
  async findPiSessionForCwd(cwd) {
    const name = piSessionDirectoryName(cwd);
    if (!name) return null;
    const directory = join(localPiDirectory(), "sessions", name);
    let newest: SessionFile | null = null;
    try {
      for (const entry of await readdir(directory)) {
        if (!entry.endsWith(".jsonl")) continue;
        const file = await localSessionFile(join(directory, entry));
        if (file && (!newest || file.mtimeMs > newest.mtimeMs)) newest = file;
      }
    } catch {
      return null;
    }
    return newest;
  },
  async findClaudeSessionById() {
    return null;
  },
  async findClaudeSuccessor(path, id) {
    // The search is a POSIX shell script; a Windows bridge keeps the
    // transcript Herdr reports.
    if (process.platform === "win32" || !validClaudeSessionId(id)) return null;
    const proc = Bun.spawn(["sh", "-c", CLAUDE_SUCCESSOR_SCRIPT], {
      env: { ...process.env, f: path, id },
      stdout: "pipe",
      stderr: "ignore",
      timeout: SESSION_FILE_TIMEOUT_MS,
    });
    const found = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return found || null;
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
  /** How many bytes of remote transcripts are kept in all. */
  keptTextBytes?: number;
}): AgentSessionFileAccess {
  if (!args.sshHost) return localAgentSessionFiles;
  const host = args.sshHost;
  const keptBudget = args.keptTextBytes ?? KEPT_TEXT_BYTES;

  async function runRemote(
    command: string,
    timeoutMs = SESSION_FILE_TIMEOUT_MS,
  ) {
    const result = await args.runBinaryProcessWithTimeout(
      sshReadCommandArgv(
        host,
        `bash -lc ${args.shQuote(command)}`,
        [],
        "agent.session.read",
      ),
      timeoutMs,
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
      sshReadCommandArgv(
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

  /**
   * The newest file named for a session under a directory on the host:
   * `root` and `names` are shell (find) expressions using $id. Symbolic links
   * are followed: project folders may link to where sessions are kept.
   */
  async function findRemoteSession(
    id: string,
    root: string,
    names: string,
    label: string,
  ): Promise<SessionFile | null> {
    const command = `
set -eu
id=${args.shQuote(id)}
root="${root}"
[ -d "$root" ] || exit 44
latest=""
latest_mtime=0
while IFS= read -r -d '' candidate; do
  mtime="$(stat -c %Y "$candidate" 2>/dev/null || stat -f %m "$candidate")"
  if [ "$mtime" -ge "$latest_mtime" ]; then
    latest="$candidate"
    latest_mtime="$mtime"
  fi
done < <(find -L "$root" -type f \\( ${names} \\) -print0)
[ -n "$latest" ] || exit 44
size="$(stat -c %s "$latest" 2>/dev/null || stat -f %z "$latest")"
path64="$(printf '%s' "$latest" | base64 | tr -d '\\n')"
printf '%s\\t%s\\t%s\\n' "$size" "$latest_mtime" "$path64"
`;
    const result = await args.runBinaryProcessWithTimeout(
      sshReadCommandArgv(
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
          `remote ${label} session search exited ${result.code}`
        )
          .trim()
          .slice(0, 1000),
      );
    }
    return parseRemoteFileMetadata(result.stdout.toString("utf8"));
  }

  // Transcripts only grow: keep each one read, most recent last, and fetch
  // only its new end next time, from a little before so a file rewritten
  // in place shows up as a mismatch and is read whole. The prefix is hashed
  // on the host too: an edit before the overlap must not be silently lost.
  const kept = new Map<string, { identity: string; bytes: Buffer }>();
  let keptBytes = 0;
  function forget(path: string) {
    const old = kept.get(path);
    if (old) keptBytes -= old.bytes.length;
    kept.delete(path);
  }
  function keep(path: string, identity: string, bytes: Buffer) {
    forget(path);
    if (!identity || bytes.length > keptBudget) return;
    kept.set(path, { identity, bytes });
    keptBytes += bytes.length;
    while (keptBytes > keptBudget) forget(kept.keys().next().value!);
  }
  async function readRemoteBytes(path: string): Promise<Buffer> {
    const old = kept.get(path);
    const overlap = old ? Math.min(KEPT_TEXT_OVERLAP, old.bytes.length) : 0;
    const output = await runRemote(
      `set -eu
path=${args.shQuote(path)}
known=${args.shQuote(old && overlap ? old.identity : "")}
identity="$(stat -c '%d:%i' "$path" 2>/dev/null || stat -f '%d:%i' "$path")"
matches=false
if [ -n "$known" ] && [ "$identity" = "$known" ]; then
  sum=""
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(head -c ${old?.bytes.length ?? 0} "$path" | sha256sum)"
  elif command -v shasum >/dev/null 2>&1; then
    sum="$(head -c ${old?.bytes.length ?? 0} "$path" | shasum -a 256)"
  fi
  if [ "${"${sum%% *}"}" = ${args.shQuote(old ? createHash("sha256").update(old.bytes).digest("hex") : "")} ]; then matches=true; fi
fi
if [ "$matches" = true ]; then
  printf '%s\ttail\n' "$identity"
  tail -c +${(old?.bytes.length ?? 0) - overlap + 1} "$path"
else
  printf '%s\tfull\n' "$identity"
  cat "$path"
fi`,
      SESSION_READ_TIMEOUT_MS,
    );
    const newline = output.indexOf(10);
    const [identity = "", mode] = output
      .subarray(0, Math.max(0, newline))
      .toString("utf8")
      .split("\t");
    const body = output.subarray(newline + 1);
    let bytes: Buffer;
    if (mode === "tail") {
      const seen = old?.bytes.subarray(old.bytes.length - overlap);
      if (!old || !seen || !body.subarray(0, overlap).equals(seen)) {
        forget(path);
        return readRemoteBytes(path);
      }
      bytes = Buffer.concat([old.bytes, body.subarray(overlap)]);
    } else {
      bytes = Buffer.from(body);
    }
    keep(path, identity, bytes);
    return bytes;
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
      return (await readRemoteBytes(path)).toString("utf8");
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
    findPiSessionById(id) {
      return findRemoteSession(
        id,
        "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions",
        '-name "$id.jsonl" -o -name "*_$id.jsonl"',
        "Pi",
      );
    },
    findPiSessionForCwd(cwd) {
      const name = piSessionDirectoryName(cwd);
      if (!name) return Promise.resolve(null);
      return findRemoteSession(
        "",
        `\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/${name}`,
        '-name "*.jsonl"',
        "Pi",
      );
    },
    async findClaudeSuccessor(path, id) {
      if (!validClaudeSessionId(id)) return null;
      const found = (
        await runRemote(
          `f=${args.shQuote(path)}\nid=${args.shQuote(id)}\n${CLAUDE_SUCCESSOR_SCRIPT}`,
        )
      )
        .toString("utf8")
        .trim();
      return found || null;
    },
    findClaudeSessionById(id) {
      // Claude names a transcript after its session ID, a UUID.
      if (!validClaudeSessionId(id)) return Promise.resolve(null);
      return findRemoteSession(
        id,
        "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects",
        '-name "$id.jsonl"',
        "Claude",
      );
    },
  };
}
