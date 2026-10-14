import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_FAILURE, EXIT_OK } from "./command";
import { createDoctorCommand, type DoctorDependencies } from "./doctor";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

const healthy: DoctorDependencies = {
  probe: async () => true,
  portInUse: () => true,
  testSockets: async () => ({ ok: true, version: "0.9.4", protocol: 7 }),
  herdrService: () => ({ installed: false, active: false }),
  latestVersion: async () => "1.2.3",
  lanIPs: () => ["192.168.1.20"],
};

async function doctor(dependencies: DoctorDependencies, args = ["--json"]) {
  const code = await createDoctorCommand(dependencies).run(args, cli.context);
  const result = JSON.parse(cli.output.join("\n"));
  const check = (name: string) =>
    result.checks.find((entry: { name: string }) => entry.name === name);
  return { code, result, check };
}

describe("roamgate doctor", () => {
  test("passes a healthy foreground installation and redacts the token", async () => {
    cli = createTestCli();
    cli.writeConfig("HOST=0.0.0.0\nPORT=8787\n");
    writeFileSync(
      join(cli.home, ".config", "roamgate", "auth-token"),
      "c".repeat(64),
    );
    const { code, result, check } = await doctor(healthy);
    expect(code).toBe(EXIT_OK);
    expect(result.ok).toBe(true);
    expect(check("Herdr").detail).toContain("Herdr 0.9.4, protocol 7");
    expect(check("Network").detail).toContain("http://192.168.1.20:8787");
    expect(check("Service").status).toBe("warn");
    expect(check("Updates").status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("c".repeat(64));
  });

  test("fails on an invalid service config with a fix", async () => {
    cli = createTestCli();
    cli.writeConfig("PORT=0\n");
    const { code, check } = await doctor(healthy);
    expect(code).toBe(EXIT_FAILURE);
    expect(check("Service config")).toMatchObject({ status: "fail" });
    expect(check("Service config").hint).toContain("roamgate config edit");
  });

  test("explains a port held by another process", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    const { check } = await doctor({ ...healthy, probe: async () => false });
    expect(check("Listener")).toMatchObject({ status: "fail" });
    expect(check("Listener").detail).toContain("port 8787 is held");
  });

  test("reports an unreachable Herdr with the setup command", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    const { code, check } = await doctor({
      ...healthy,
      testSockets: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(check("Herdr").detail).toContain(
      join(cli.home, ".config", "herdr", "herdr.sock"),
    );
    expect(check("Herdr").hint).toContain("roamgate herdr setup");
  });

  test("skips SSH Herdr, disabled push and offline update checks", async () => {
    cli = createTestCli();
    cli.writeConfig("HERDR_SSH_HOST=me@box\nROAMGATE_WEB_PUSH_SUBJECT=\n");
    const { check } = await doctor(healthy, ["--json", "--offline"]);
    expect(check("Herdr").status).toBe("skip");
    expect(check("Web Push").status).toBe("skip");
    expect(check("Updates").status).toBe("skip");
  });

  test("warns about available updates", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    const { check } = await doctor({
      ...healthy,
      latestVersion: async () => "1.3.0",
    });
    expect(check("Updates")).toMatchObject({
      status: "warn",
      hint: "Run `roamgate update`.",
    });
  });

  test.skipIf(!Bun.which("openssl"))(
    "warns about a certificate that expires soon",
    async () => {
      cli = createTestCli();
      const cert = join(cli.home, "cert.pem");
      const key = join(cli.home, "key.pem");
      const generated = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "3",
          "-subj",
          "/CN=roamgate.test",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(generated.exitCode).toBe(0);
      cli.writeConfig(
        `HOST=0.0.0.0\nROAMGATE_TLS_CERT=${cert}\nROAMGATE_TLS_KEY=${key}\n`,
      );
      const { check } = await doctor(healthy);
      expect(check("TLS certificate").status).toBe("warn");
      expect(check("TLS certificate").detail).toContain("CN=roamgate.test");
      expect(check("Network").detail).toContain("HTTPS");
    },
  );

  test("flags an invalid connection registry", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    mkdirSync(join(cli.home, ".config", "roamgate"), { recursive: true });
    writeFileSync(
      join(cli.home, ".config", "roamgate", "connections.json"),
      "{",
      {
        mode: 0o600,
      },
    );
    const { check } = await doctor(healthy);
    expect(check("Connections")).toMatchObject({ status: "fail" });
  });

  test("prints a readable summary", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    const code = await createDoctorCommand(healthy).run([], cli.context);
    expect(code).toBe(EXIT_OK);
    // Not installed as a service, and no login token has been created yet.
    expect(cli.output.at(-1)).toMatch(/^\d+ ok, 2 warnings, 0 failures$/);
    expect(cli.output).toContain(
      "                      Run `roamgate service install` to start Roamgate at login.",
    );
  });

  test("fails on a corrupt token with the rotate command", async () => {
    cli = createTestCli();
    cli.writeConfig("");
    writeFileSync(join(cli.home, ".config", "roamgate", "auth-token"), "x\n");
    const { code, check } = await doctor(healthy);
    expect(code).toBe(EXIT_FAILURE);
    expect(check("Login").hint).toContain("roamgate auth rotate");
  });

  test("a loaded but crashed LaunchAgent is not reported as running", async () => {
    cli = createTestCli({
      runtime: { platform: "darwin" },
      captureCommand: () => ({
        code: 0,
        stdout:
          "gui/501/dev.roamgate = {\n\tstate = waiting\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n",
      }),
    });
    cli.writeConfig("");
    const agents = join(cli.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "dev.roamgate.plist"), "<plist/>");
    const { check } = await doctor({
      ...healthy,
      probe: async () => false,
      portInUse: () => false,
    });
    expect(check("Service")).toMatchObject({
      status: "fail",
      detail: "installed but not running",
    });
  });
});
