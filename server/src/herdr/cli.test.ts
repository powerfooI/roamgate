import { describe, expect, test } from "bun:test";
import { runHerdrCommand } from "./cli";

function fakeConfig() {
  return {
    sshHost: undefined,
    session: undefined,
    hasExplicitSocketPath: false,
    hasExplicitClientSocketPath: false,
    socketPath: "/tmp/test-herdr.sock",
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (message: string) => out.push(message),
    error: (message: string) => err.push(message),
  };
}

describe("runHerdrCommand", () => {
  test("ignores non-herdr commands", async () => {
    expect(await runHerdrCommand(["service", "install"], "0.0.0")).toBeNull();
    expect(await runHerdrCommand([], "0.0.0")).toBeNull();
  });

  test("prints help for bare or unknown herdr commands", async () => {
    const help = capture();
    expect(await runHerdrCommand(["herdr"], "0.0.0", help)).toBe(0);
    expect(help.out.join("\n")).toContain("roamgate herdr setup");

    const unknown = capture();
    expect(await runHerdrCommand(["herdr", "restart"], "0.0.0", unknown)).toBe(
      1,
    );
    expect(unknown.err.join("\n")).toContain("unknown herdr action");
  });

  test("status reports a running server", async () => {
    const io = capture();
    const code = await runHerdrCommand(["herdr", "status"], "0.0.0", {
      ...io,
      loadConfig: () => fakeConfig() as never,
      detect: () =>
        Promise.resolve({ state: "running", version: "0.9.0", protocol: 22 }),
      serviceStatus: () => ({ installed: true, active: true }),
    });
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("running (version 0.9.0");
    expect(io.out.join("\n")).toContain("installed, active");
  });

  test("status points missing installs at setup", async () => {
    const io = capture();
    const code = await runHerdrCommand(["herdr", "status"], "0.0.0", {
      ...io,
      loadConfig: () => fakeConfig() as never,
      detect: () => Promise.resolve({ state: "missing" }),
      serviceStatus: () => ({ installed: false, active: false }),
    });
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("not installed");
    expect(io.out.join("\n")).toContain("roamgate herdr setup");
  });

  test("setup prints the outcome", async () => {
    const io = capture();
    const code = await runHerdrCommand(["herdr", "setup"], "0.0.0", {
      ...io,
      loadConfig: () => fakeConfig() as never,
      setup: () =>
        Promise.resolve({
          outcome: "installed-and-started",
          binaryPath: "/managed/herdr",
          version: "0.9.0",
          protocol: 22,
        }),
    });
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("Installed Herdr 0.9.0");
    expect(io.out.join("\n")).toContain("/managed/herdr");
  });

  test("setup failures print the reason and exit 1", async () => {
    const io = capture();
    const code = await runHerdrCommand(["herdr", "setup"], "0.0.0", {
      ...io,
      loadConfig: () => fakeConfig() as never,
      setup: () => Promise.reject(new Error("checksum does not match")),
    });
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("checksum does not match");
  });
});
