import { afterEach, describe, expect, test } from "bun:test";
import {
  type CliCommand,
  CONTINUE_TO_SERVER,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
} from "./command";
import { cliCommands, runCli, topLevelHelp } from "./index";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

function fakeCommand(run: CliCommand["run"]): CliCommand {
  return {
    name: "fake",
    summary: "a fake command",
    help: () => "fake help",
    run,
  };
}

describe("runCli", () => {
  test("leaves server invocations to the listener", async () => {
    cli = createTestCli();
    expect(await runCli([], cli.context)).toBeNull();
    expect(await runCli(["--port", "9000"], cli.context)).toBeNull();
    expect(await runCli(["--help"], cli.context)).toBeNull();
  });

  test("rejects unknown commands with a usage exit code", async () => {
    cli = createTestCli();
    expect(await runCli(["sevrice"], cli.context)).toBe(EXIT_USAGE);
    expect(cli.errors[0]).toBe("roamgate: unknown command: sevrice");
  });

  test("top-level help lists every command, including herdr", async () => {
    cli = createTestCli();
    expect(await runCli(["help"], cli.context)).toBe(EXIT_OK);
    const help = cli.output.join("\n");
    for (const command of cliCommands()) {
      expect(help).toContain(`  ${command.name} `);
    }
    expect(help).toContain("--socket-path <path>");
    expect(topLevelHelp(cliCommands())).toBe(help);
  });

  test("help <command> prints that command's help", async () => {
    cli = createTestCli();
    expect(await runCli(["help", "doctor"], cli.context)).toBe(EXIT_OK);
    expect(cli.output.join("\n")).toContain("roamgate doctor [--offline]");
    expect(await runCli(["help", "nope"], cli.context)).toBe(EXIT_USAGE);
  });

  test("maps usage errors and failures to distinct exit codes", async () => {
    cli = createTestCli();
    const usage = fakeCommand(async () => {
      throw new UsageError("bad flag");
    });
    expect(await runCli(["fake"], cli.context, [usage])).toBe(EXIT_USAGE);
    expect(cli.errors).toEqual([
      "roamgate fake: bad flag",
      "Run `roamgate fake --help` for usage.",
    ]);
    const failing = fakeCommand(async () => {
      throw new Error("disk full");
    });
    expect(await runCli(["fake"], cli.context, [failing])).toBe(EXIT_FAILURE);
    expect(cli.errors.at(-1)).toBe("roamgate fake: disk full");
  });

  test("passes the remaining arguments and continuation through", async () => {
    cli = createTestCli();
    let received: string[] = [];
    const command = fakeCommand(async (args) => {
      received = args;
      return CONTINUE_TO_SERVER;
    });
    expect(await runCli(["fake", "a", "--b"], cli.context, [command])).toBe(
      CONTINUE_TO_SERVER,
    );
    expect(received).toEqual(["a", "--b"]);
  });

  test("service logs is routed to the log viewer", async () => {
    cli = createTestCli({ runCommand: () => 0 });
    expect(await runCli(["service", "logs", "-n", "5"], cli.context)).toBe(0);
    expect(cli.commands).toEqual([
      [
        "journalctl",
        "--user",
        "--unit",
        "roamgate.service",
        "--no-pager",
        "--lines",
        "5",
      ],
    ]);
  });

  test("unknown flags of new commands are usage errors", async () => {
    cli = createTestCli();
    expect(await runCli(["url", "--nope"], cli.context)).toBe(EXIT_USAGE);
    expect(cli.errors[0]).toContain("roamgate url:");
  });
});
