import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_FAILURE } from "./command";
import { runServiceLogs } from "./service-logs";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

describe("roamgate service logs", () => {
  test("follows the systemd journal on Linux", () => {
    cli = createTestCli({ runCommand: () => 0 });
    expect(runServiceLogs(["-f", "--lines", "20"], cli.context)).toBe(0);
    expect(cli.commands).toEqual([
      [
        "journalctl",
        "--user",
        "--unit",
        "roamgate.service",
        "--no-pager",
        "--lines",
        "20",
        "--follow",
      ],
    ]);
  });

  test("tails the LaunchAgent log files on macOS", () => {
    cli = createTestCli({
      runtime: { platform: "darwin" },
      runCommand: () => 0,
    });
    expect(runServiceLogs([], cli.context)).toBe(EXIT_FAILURE);
    const logs = join(cli.home, "Library", "Logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "roamgate.stderr.log"), "");
    writeFileSync(join(logs, "roamgate.stdout.log"), "");
    expect(runServiceLogs(["-n", "5", "--follow"], cli.context)).toBe(0);
    expect(cli.commands).toEqual([
      [
        "tail",
        "-n",
        "5",
        "-F",
        join(logs, "roamgate.stderr.log"),
        join(logs, "roamgate.stdout.log"),
      ],
    ]);
  });

  test("explains that Windows tasks do not capture output", () => {
    cli = createTestCli({ runtime: { platform: "win32" } });
    expect(runServiceLogs([], cli.context)).toBe(EXIT_FAILURE);
    expect(cli.errors[0]).toContain("does not capture output");
  });

  test("rejects invalid line counts", () => {
    cli = createTestCli();
    expect(() => runServiceLogs(["-n", "lots"], cli.context)).toThrow(
      "--lines",
    );
  });
});
