import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertSshTunnelPlatformSupported,
  type SshTunnelConfig,
} from "../bridge/ssh-tunnel";
import type { SshConnectionProfile } from "./profiles";

export type SshRuntimeConfigDependencies = {
  createDirectory?: () => string;
  chmod?: (path: string, mode: number) => void;
  stat?: (path: string) => { isDirectory(): boolean; mode: number };
  removeDirectory?: (path: string) => void;
  platform?: string;
};

export function createSshProfileRuntimeConfig(
  profile: SshConnectionProfile,
  dependencies: SshRuntimeConfigDependencies = {},
): SshTunnelConfig {
  const platform = dependencies.platform ?? process.platform;
  assertSshTunnelPlatformSupported(platform);
  const directory =
    dependencies.createDirectory?.() ?? mkdtempSync("/tmp/roamgate-ssh-");
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
    if (
      !directoryStat.isDirectory() ||
      (platform !== "win32" && (directoryStat.mode & 0o077) !== 0) ||
      Buffer.byteLength(socketPath) > 100 ||
      Buffer.byteLength(clientSocketPath) > 100
    ) {
      throw new Error(
        "SSH runtime directory must be a private directory with short socket paths",
      );
    }
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
    };
  } catch (error) {
    removeDirectory(directory);
    throw error;
  }
}
