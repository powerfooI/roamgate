import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";
import { terminalPathText } from "./terminal-path-text";

export const IMAGE_UPLOAD_DIRECTORY_PREFIX = "roamgate-images-";

// A shared temp root is writable by every user, so a fixed folder name could
// already exist with another owner, loose permissions, or as a symlink.
// mkdtemp always creates a fresh, unpredictable folder owned by this user with
// 0700 permissions, and the folder is checked again before each reuse.
async function isPrivateDirectory(
  directory: string,
  platform: NodeJS.Platform,
) {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    if (platform === "win32") return true;
    return stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function createImageUploadHandler(args: {
  sshHost: () => string | undefined;
  tempRoot?: () => string;
  platform?: NodeJS.Platform;
}) {
  const platform = args.platform ?? process.platform;
  let privateDirectory: Promise<string> | undefined;

  const uploadDirectory = async () => {
    const cached = privateDirectory;
    if (cached) {
      const directory = await cached.catch(() => undefined);
      if (directory && (await isPrivateDirectory(directory, platform))) {
        return directory;
      }
      // Temp cleaners may delete the folder; replace it rather than recreate
      // a predictable path.
      if (privateDirectory === cached) privateDirectory = undefined;
    }
    privateDirectory ??= mkdtemp(
      join(args.tempRoot?.() ?? tmpdir(), IMAGE_UPLOAD_DIRECTORY_PREFIX),
    );
    return privateDirectory;
  };

  return async function handleImageUpload(req: Request): Promise<Response> {
    try {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length === 0) {
        return Response.json({ error: "empty body" }, { status: 400 });
      }
      if (buf.length > 25 * 1024 * 1024) {
        return Response.json(
          { error: "image too large (>25MB)" },
          { status: 413 },
        );
      }
      const ext =
        (req.headers.get("x-image-ext") || "png")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "png";
      const name = `img-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      const sshHost = args.sshHost();

      if (sshHost) {
        const remotePath = `/tmp/${name}`;
        const proc = Bun.spawn(sshCommandArgv(sshHost, `cat > ${remotePath}`), {
          stdin: buf,
          stdout: "pipe",
          stderr: "pipe",
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          return Response.json(
            { error: `ssh upload failed: ${err.trim() || `exit ${code}`}` },
            { status: 502 },
          );
        }
        return Response.json({
          path: remotePath,
          text: terminalPathText(remotePath, "linux"),
          remote: true,
        });
      }

      const localPath = join(await uploadDirectory(), name);
      await writeFile(localPath, buf, { flag: "wx", mode: 0o600 });
      return Response.json({
        path: localPath,
        text: terminalPathText(localPath, platform),
        remote: false,
      });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  };
}
