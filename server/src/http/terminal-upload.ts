import { open, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";
import { roamgateEnv } from "../config/environment";
import { shQuote } from "../utils/process-utils";
import { terminalPathText } from "./terminal-path-text";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETENTION_HOURS = 24;
export const TERMINAL_UPLOAD_TIMEOUT_MS = 300_000;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function terminalUploadMaxBytes() {
  return positiveInteger(roamgateEnv("UPLOAD_MAX_BYTES"), DEFAULT_MAX_BYTES);
}

export function terminalUploadRequestBodyLimit() {
  return Math.max(128 * 1024 * 1024, terminalUploadMaxBytes());
}

export function sanitizeTerminalUploadName(
  input: string,
  platform: NodeJS.Platform = process.platform,
) {
  const basename = input.split(/[\\/]/).pop() ?? "";
  const safe = basename.replace(/[^A-Za-z0-9._+-]/g, "_");
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 ? safe.slice(dot).slice(0, 24) : "";
  const stem = (dot > 0 ? safe.slice(0, dot) : safe).slice(
    0,
    120 - extension.length,
  );
  const name =
    stem && stem !== "." && stem !== ".."
      ? stem + extension
      : `file${extension}`;
  if (platform !== "win32") return name;
  const windowsName = name.replace(/\.+$/, "") || "file";
  return /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(
    windowsName.split(".")[0] ?? "",
  )
    ? `_${windowsName}`
    : windowsName;
}

export function remoteTerminalCleanupScript(retentionMinutes: number) {
  return `set -eu
umask 077
case "\${TMPDIR:-/tmp}" in /*) temp_root="\${TMPDIR:-/tmp}" ;; *) temp_root=/tmp ;; esac
root="$temp_root/roamgate-uploads-$(id -u)"
[ ! -L "$root" ] || exit 1
mkdir -m 700 -p "$root"
[ -d "$root" ] && [ ! -L "$root" ] || exit 1
owner=$(stat -c %u "$root" 2>/dev/null || stat -f %u "$root")
mode=$(stat -c %a "$root" 2>/dev/null || stat -f %Lp "$root")
[ "$owner" = "$(id -u)" ] && [ "$mode" = 700 ] || exit 1
find "$root" -mindepth 1 -maxdepth 1 -type d -name 'upload-*' -mmin +${retentionMinutes} -exec rm -rf -- {} +`;
}

export function remoteTerminalUploadScript(
  name: string,
  retentionMinutes: number,
) {
  return `${remoteTerminalCleanupScript(retentionMinutes)}
directory=$(mktemp -d "$root/upload-XXXXXXXX")
trap 'rm -rf -- "$directory"' EXIT
path="$directory/"${shQuote(name)}
cat > "$path"
chmod 600 "$path"
printf '%s' "$path"
trap - EXIT`;
}

export function createTerminalUploadHandler(args: {
  sshHost: () => string | undefined;
  tempRoot?: () => string;
  platform?: NodeJS.Platform;
  maxBytes?: number;
  retentionHours?: number;
  rejectEmpty?: boolean;
  /** Test seam for the bounded SSH transfer deadline. */
  uploadTimeoutMs?: number;
  onCleanupError?: (error: unknown) => void;
}) {
  const platform = args.platform ?? process.platform;
  const maxBytes = args.maxBytes ?? terminalUploadMaxBytes();
  const retentionHours =
    args.retentionHours ??
    positiveInteger(
      roamgateEnv("UPLOAD_RETENTION_HOURS"),
      DEFAULT_RETENTION_HOURS,
    );
  const retentionMs = retentionHours * 60 * 60 * 1000;
  const root = join(
    args.tempRoot?.() ?? tmpdir(),
    `roamgate-uploads-${process.getuid?.() ?? "user"}`,
  );
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupTask: Promise<void> | undefined;

  async function privateRoot() {
    await mkdir(root, { mode: 0o700, recursive: true });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    ) {
      throw new Error("unsafe terminal upload directory");
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.name.startsWith("upload-") || !entry.isDirectory()) continue;
      const path = join(root, entry.name);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info && Date.now() - info.mtimeMs > retentionMs) {
        await rm(path, { recursive: true, force: true });
      }
    }
    return root;
  }

  function sweepExpired() {
    cleanupTask ??= (async () => {
      await privateRoot();
      const host = args.sshHost();
      if (!host) return;
      const proc = Bun.spawn(
        sshCommandArgv(
          host,
          `sh -c ${shQuote(remoteTerminalCleanupScript(retentionHours * 60))}`,
        ),
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(
          `ssh upload cleanup failed: ${stderr.trim() || `exit ${code}`}`,
        );
      }
    })().finally(() => {
      cleanupTask = undefined;
    });
    return cleanupTask;
  }

  async function handleTerminalUpload(
    req: Request,
    filename: string | null,
  ): Promise<Response> {
    if (!filename) {
      return Response.json({ error: "filename is required" }, { status: 400 });
    }
    if (!req.body) {
      return Response.json({ error: "empty body" }, { status: 400 });
    }
    const name = sanitizeTerminalUploadName(filename, platform);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(await privateRoot(), "upload-"));
      const localPath = join(directory, name);
      const file = await open(localPath, "wx", 0o600);
      let size = 0;
      try {
        for await (const chunk of req.body) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            return Response.json(
              { error: `file too large (>${maxBytes} bytes)` },
              { status: 413 },
            );
          }
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      if (!size && args.rejectEmpty) {
        return Response.json({ error: "empty body" }, { status: 400 });
      }
      const host = args.sshHost();
      if (host) {
        req.signal.throwIfAborted();
        const proc = Bun.spawn(
          sshCommandArgv(
            host,
            `sh -c ${shQuote(remoteTerminalUploadScript(name, retentionHours * 60))}`,
          ),
          {
            stdin: Bun.file(localPath),
            stdout: "pipe",
            stderr: "pipe",
            signal: req.signal,
            timeout: args.uploadTimeoutMs ?? TERMINAL_UPLOAD_TIMEOUT_MS,
            killSignal: "SIGKILL",
          },
        );
        const [code, path, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        if (code !== 0 || !path.startsWith("/")) {
          return Response.json(
            { error: `ssh upload failed: ${stderr.trim() || `exit ${code}`}` },
            { status: 502 },
          );
        }
        return Response.json({
          path,
          text: terminalPathText(path, "linux"),
          remote: true,
        });
      }

      // The local staging directory remains until retention cleanup.
      directory = undefined;
      return Response.json({
        path: localPath,
        text: terminalPathText(localPath, platform),
        remote: false,
      });
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 500 },
      );
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  handleTerminalUpload.startCleanup = () => {
    if (cleanupTimer) return cleanupTask ?? Promise.resolve();
    cleanupTimer = setInterval(
      () => {
        void sweepExpired().catch(args.onCleanupError ?? (() => {}));
      },
      Math.min(retentionMs, 60 * 60 * 1000),
    );
    cleanupTimer.unref?.();
    return sweepExpired();
  };
  handleTerminalUpload.stopCleanup = () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  };
  return handleTerminalUpload;
}
