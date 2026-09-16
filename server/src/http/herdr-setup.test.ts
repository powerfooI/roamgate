import { expect, test } from "bun:test";
import { VERIFIED_HERDR_VERSION } from "../herdr/release";
import { assertManagedSetupAllowed } from "../herdr/bootstrap";
import type { LocalConnectionProfile } from "../connections/profiles";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "./herdr-setup";

test("setup guard uses the configured profile even without a ready runtime", () => {
  const config = {
    socketPath: "/tmp/herdr.sock",
    clientSocketPath: "/tmp/herdr-client.sock",
    hasExplicitSocketPath: false,
    hasExplicitClientSocketPath: false,
  };
  const local: LocalConnectionProfile = {
    id: "local",
    label: "Local",
    type: "local",
    control_socket_path: config.socketPath,
    client_socket_path: config.clientSocketPath,
    auto_connect: true,
  };
  expect(() =>
    assertManagedSetupAllowed(herdrSetupGuardForProfile(config, local)),
  ).not.toThrow();
  for (const profile of [
    { ...local, control_socket_path: "/tmp/custom-herdr.sock" },
    { ...local, client_socket_path: "/tmp/custom-client.sock" },
    {
      id: "remote",
      label: "Remote",
      type: "ssh" as const,
      ssh_destination: "example.com",
      remote_control_socket_path: config.socketPath,
      remote_client_socket_path: config.clientSocketPath,
      auto_connect: true,
    },
  ]) {
    expect(() =>
      assertManagedSetupAllowed(herdrSetupGuardForProfile(config, profile)),
    ).toThrow();
  }
  expect(() => herdrSetupGuardForProfile(config, undefined)).toThrow();
  expect(() =>
    assertManagedSetupAllowed(
      herdrSetupGuardForProfile(
        { ...config, hasExplicitSocketPath: true },
        local,
      ),
    ),
  ).toThrow();
});

test("setup UI metadata uses the pinned release and hides unsupported targets", async () => {
  for (const guard of [
    {},
    { sshHost: "example.com" },
    { session: "work" },
    { hasExplicitSocketPath: true },
  ]) {
    const handlers = createHerdrSetupHandlers({
      ping: async () => ({ version: "0.9.0", protocol: 22 }),
      guard: () => guard,
    });
    expect(await (await handlers.handleHerdrStatus()).json()).toEqual({
      state: "running",
      version: "0.9.0",
      protocol: 22,
      can_setup: Object.keys(guard).length === 0,
      verified_version: VERIFIED_HERDR_VERSION,
    });
    const response = await handlers.handleHerdrSetup(
      new Request("http://localhost/api/herdr/setup", { method: "POST" }),
    );
    expect(response.status).toBe(403);
  }
});
