import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  SSH_RUNTIME_DIRECTORY_ROOT,
  SSH_RUNTIME_OWNER_FILE,
} from "../bridge/ssh-master";
import {
  assertSshTunnelPlatformSupported,
  type SshTunnelConfig,
} from "../bridge/ssh-tunnel";
import { roamgateEnv } from "../config/environment";
import type { SshConnectionProfile } from "./profiles";

export type SshRuntimeConfigDependencies = {
  createDirectory?: () => string;
  chmod?: (path: string, mode: number) => void;
  stat?: (path: string) => { isDirectory(): boolean; mode: number };
  removeDirectory?: (path: string) => void;
  /** Records this process as the directory's owner for the orphan sweep. */
  writeOwner?: (directory: string) => void;
  platform?: string;
  environment?: Record<string, string | undefined>;
};

export function createSshProfileRuntimeConfig(
  profile: SshConnectionProfile,
  dependencies: SshRuntimeConfigDependencies = {},
): SshTunnelConfig {
  const platform = dependencies.platform ?? process.platform;
  assertSshTunnelPlatformSupported(platform);
  const directory =
    dependencies.createDirectory?.() ??
    mkdtempSync(join(SSH_RUNTIME_DIRECTORY_ROOT, "roamgate-ssh-"));
  const chmod = dependencies.chmod ?? chmodSync;
  const stat = dependencies.stat ?? statSync;
  const removeDirectory =
    dependencies.removeDirectory ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));
  try {
    chmod(directory, 0o700);
    const directoryStat = stat(directory);
    const socketPath = join(directory, "control.sock");
    const clientSocketPath = join(directory, "render.sock");
    const masterControlPath = join(directory, "m.ctl");
    if (
      !directoryStat.isDirectory() ||
      (platform !== "win32" && (directoryStat.mode & 0o077) !== 0) ||
      Buffer.byteLength(socketPath) > 100 ||
      Buffer.byteLength(clientSocketPath) > 100 ||
      // The master first binds "<path>.<16 random chars>", then renames it.
      Buffer.byteLength(masterControlPath) + 17 > 100
    ) {
      throw new Error(
        "SSH runtime directory must be a private directory with short socket paths",
      );
    }
    (
      dependencies.writeOwner ??
      ((path: string) =>
        writeFileSync(join(path, SSH_RUNTIME_OWNER_FILE), `${process.pid}\n`, {
          mode: 0o600,
        }))
    )(directory);
    const remoteControlSocketPath =
      profile.remote_control_socket_path || undefined;
    const remoteClientSocketPath =
      profile.remote_client_socket_path || undefined;
    return {
      socketPath,
      clientSocketPath,
      sshHost: profile.ssh_destination,
      remotePlatform: profile.remote_platform,
      remoteHerdrPath: profile.remote_herdr_path?.replaceAll("/", "\\"),
      session: profile.remote_session,
      // Empty profile socket paths mean "infer": the tunnel resolves the
      // default Herdr sockets under the remote home directory over SSH.
      hasExplicitSocketPath: remoteControlSocketPath !== undefined,
      hasExplicitClientSocketPath: remoteClientSocketPath !== undefined,
      remoteSocketPath: remoteControlSocketPath,
      remoteClientSocketPath: remoteClientSocketPath,
      ownedRuntimeDirectory: directory,
      masterControlPath:
        roamgateEnv("DISABLE_SSH_MASTER", dependencies.environment) === "1"
          ? undefined
          : masterControlPath,
    };
  } catch (error) {
    removeDirectory(directory);
    throw error;
  }
}
