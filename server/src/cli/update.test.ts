import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_FAILURE, EXIT_OK } from "./command";
import { createUpdateCommand, rollbackCommand } from "./update";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

const manifest = (version: string) =>
  JSON.stringify({
    schema: 1,
    name: "roamgate",
    version,
    platform: "linux-x64",
    archive: "roamgate-linux-x64.tar.xz",
    sha256: "a".repeat(64),
  });

function fakeProcess(version: string, installCode = 0) {
  const calls: string[][] = [];
  return {
    calls,
    runProcess: async (argv: string[]) => {
      calls.push(argv);
      return argv[0] === "curl"
        ? { code: 0, stdout: manifest(version), stderr: "" }
        : {
            code: installCode,
            stdout: "",
            stderr: installCode ? "checksum mismatch" : "",
          };
    },
  };
}

describe("roamgate update", () => {
  test("--check compares against the latest manifest", async () => {
    cli = createTestCli();
    const fake = fakeProcess("1.3.0");
    const code = await createUpdateCommand(fake).run(
      ["--check", "--json"],
      cli.context,
    );
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(cli.output.join("\n"))).toEqual({
      current_version: "1.2.3",
      latest_version: "1.3.0",
      update_available: true,
      platform: "linux-x64",
    });
    expect(fake.calls[0]).toContain(
      "https://github.com/powerfooI/roamgate/releases/latest/download/roamgate-linux-x64.update.json",
    );
  });

  test("uses a mirror from the service config", async () => {
    cli = createTestCli();
    cli.writeConfig(
      "ROAMGATE_UPDATE_BASE_URL=https://mirror.example/roamgate/\n",
    );
    const fake = fakeProcess("1.2.3");
    await createUpdateCommand(fake).run(["--check"], cli.context);
    expect(fake.calls[0].at(-1)).toBe(
      "https://mirror.example/roamgate/roamgate-linux-x64.update.json",
    );
    expect(cli.output.at(-1)).toBe("Up to date.");
  });

  test("installs over the running executable with the shared verifier", async () => {
    cli = createTestCli();
    const fake = fakeProcess("1.3.0");
    expect(await createUpdateCommand(fake).run([], cli.context)).toBe(EXIT_OK);
    const [shell, flag, script] = fake.calls[1];
    expect([shell, flag]).toEqual(["sh", "-c"]);
    expect(script).toContain(`target='${cli.context.runtime.execPath}'`);
    expect(script).toContain(`expected_sha256='${"a".repeat(64)}'`);
    expect(script).toContain('backup="$target.previous"');
    expect(cli.output).toContain(
      `Installed roamgate 1.3.0 at ${cli.context.runtime.execPath}.`,
    );
  });

  test("reports installer failures and refuses source checkouts", async () => {
    cli = createTestCli();
    expect(
      await createUpdateCommand(fakeProcess("1.3.0", 1)).run([], cli.context),
    ).toBe(EXIT_FAILURE);
    expect(cli.errors[0]).toBe("roamgate update: checksum mismatch");
    cli.context.runtime.argv = ["bun", "/repo/server/src/index.ts"];
    expect(
      await createUpdateCommand(fakeProcess("1.3.0")).run([], cli.context),
    ).toBe(EXIT_FAILURE);
  });

  test("explains platforms without update packages", async () => {
    cli = createTestCli({ runtime: { platform: "win32" } });
    expect(
      await createUpdateCommand(fakeProcess("1.3.0")).run([], cli.context),
    ).toBe(EXIT_FAILURE);
    expect(cli.errors[0]).toContain("no update package for win32-x64");
  });
});

describe("roamgate rollback", () => {
  function executable(path: string, version: string) {
    writeFileSync(path, `#!/bin/sh\necho 'roamgate ${version}'\n`);
    chmodSync(path, 0o755);
  }

  test("swaps the executable with roamgate.previous and back", async () => {
    cli = createTestCli();
    const current = cli.context.runtime.execPath;
    mkdirSync(join(cli.home, "bin"));
    executable(current, "1.2.3");
    executable(`${current}.previous`, "1.1.0");
    expect(await rollbackCommand.run([], cli.context)).toBe(EXIT_OK);
    expect(readFileSync(current, "utf8")).toContain("roamgate 1.1.0");
    expect(readFileSync(`${current}.previous`, "utf8")).toContain(
      "roamgate 1.2.3",
    );
    expect(cli.output[0]).toBe("Rolled back roamgate 1.2.3 -> 1.1.0.");
    expect(await rollbackCommand.run([], cli.context)).toBe(EXIT_OK);
    expect(readFileSync(current, "utf8")).toContain("roamgate 1.2.3");
  });

  test("leaves files alone when the previous executable is unusable", async () => {
    cli = createTestCli();
    const current = cli.context.runtime.execPath;
    mkdirSync(join(cli.home, "bin"));
    executable(current, "1.2.3");
    expect(await rollbackCommand.run([], cli.context)).toBe(EXIT_FAILURE);
    writeFileSync(`${current}.previous`, "#!/bin/sh\nexit 3\n");
    chmodSync(`${current}.previous`, 0o755);
    expect(await rollbackCommand.run([], cli.context)).toBe(EXIT_FAILURE);
    expect(readFileSync(current, "utf8")).toContain("roamgate 1.2.3");
  });
});
