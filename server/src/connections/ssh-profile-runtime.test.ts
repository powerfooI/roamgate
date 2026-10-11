import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  createSshProfileRuntimeConfig as createPlatformSshProfileRuntimeConfig,
  type SshRuntimeConfigDependencies,
} from "./ssh-profile-runtime";
import type { SshConnectionProfile } from "./profiles";

const directories: string[] = [];

function createSshProfileRuntimeConfig(
  profile: SshConnectionProfile,
  dependencies: SshRuntimeConfigDependencies = {},
) {
  return createPlatformSshProfileRuntimeConfig(profile, {
    platform: "linux",
    ...dependencies,
  });
}

function profile(): SshConnectionProfile {
  return {
    id: "private-remote",
    label: "Secret Host Label",
    type: "ssh",
    ssh_destination: "operator@dev-box",
    remote_control_socket_path: "/remote/herdr.sock",
    remote_client_socket_path: "/remote/herdr-client.sock",
    auto_connect: false,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SSH profile runtime socket allocation", () => {
  test("selects Windows bridges and passes the explicit binary and session", () => {
    if (process.platform === "win32") return;
    const config = createSshProfileRuntimeConfig({
      ...profile(),
      remote_control_socket_path: "",
      remote_client_socket_path: "",
      remote_platform: "windows",
      remote_herdr_path: "C:/Test Herdr/herdr.exe",
      remote_session: "isolated-session",
    });
    directories.push(config.ownedRuntimeDirectory!);
    expect(config).toMatchObject({
      remotePlatform: "windows",
      remoteHerdrPath: String.raw`C:\Test Herdr\herdr.exe`,
      session: "isolated-session",
    });
  });
  test("allocates short private paths without profile-controlled names", () => {
    if (process.platform === "win32") return;
    const config = createSshProfileRuntimeConfig(profile());
    const directory = config.ownedRuntimeDirectory!;
    directories.push(directory);

    expect(lstatSync(directory).isDirectory()).toBeTrue();
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(config.socketPath).toBe(`${directory}/control.sock`);
    expect(config.clientSocketPath).toBe(`${directory}/render.sock`);
    expect(config.socketPath.length).toBeLessThan(100);
    expect(dirname(config.clientSocketPath)).toBe(directory);
    expect(directory).not.toContain(profile().id);
    expect(directory).not.toContain("dev-box");
    expect(config).toMatchObject({
      sshHost: "operator@dev-box",
      remoteSocketPath: profile().remote_control_socket_path,
      remoteClientSocketPath: profile().remote_client_socket_path,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    });
  });

  test("maps empty profile socket paths to remote home inference", () => {
    if (process.platform === "win32") return;
    const config = createSshProfileRuntimeConfig({
      ...profile(),
      remote_control_socket_path: "",
      remote_client_socket_path: "",
    });
    directories.push(config.ownedRuntimeDirectory!);

    expect(config).toMatchObject({
      sshHost: "operator@dev-box",
      hasExplicitSocketPath: false,
      hasExplicitClientSocketPath: false,
      remoteSocketPath: undefined,
      remoteClientSocketPath: undefined,
    });
  });

  test("rejects Windows before allocating a Unix socket directory", () => {
    let allocated = false;
    expect(() =>
      createSshProfileRuntimeConfig(profile(), {
        platform: "win32",
        createDirectory: () => {
          allocated = true;
          return "unused";
        },
      }),
    ).toThrow("cannot create a local Windows named pipe");
    expect(allocated).toBeFalse();
  });

  test("rejects a non-private injected runtime directory", () => {
    expect(() =>
      createSshProfileRuntimeConfig(profile(), {
        createDirectory: () => "/tmp/injected-runtime",
        chmod: () => undefined,
        stat: () => ({ isDirectory: () => true, mode: 0o40755 }),
        removeDirectory: () => undefined,
      }),
    ).toThrow("private directory");
  });
});
