import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_OK, EXIT_USAGE } from "./command";
import { renderCompletion } from "./completion";
import { cliCommands, runCli } from "./index";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

describe("roamgate completion", () => {
  for (const shell of ["bash", "zsh"] as const) {
    test.skipIf(!Bun.which(shell))(
      `${shell} script parses and names every command`,
      () => {
        cli = createTestCli();
        const script = renderCompletion(shell, cliCommands());
        const path = join(cli.home, `completion.${shell}`);
        writeFileSync(path, script);
        const check = Bun.spawnSync([shell, "-n", path], { stderr: "pipe" });
        expect(check.stderr.toString()).toBe("");
        expect(check.exitCode).toBe(0);
        for (const command of cliCommands())
          expect(script).toContain(command.name);
      },
    );
  }

  test.skipIf(!Bun.which("bash"))("bash completes subcommand actions", () => {
    cli = createTestCli();
    const path = join(cli.home, "completion.bash");
    writeFileSync(path, renderCompletion("bash", cliCommands()));
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `source "$1"; COMP_WORDS=(roamgate config s); COMP_CWORD=2; _roamgate; echo "\${COMPREPLY[*]}"`,
        "bash",
        path,
      ],
      { stdout: "pipe" },
    );
    expect(result.stdout.toString().trim()).toBe("show set");
  });

  test("fish script registers commands with descriptions", () => {
    const script = renderCompletion("fish", cliCommands());
    expect(script).toContain(
      "complete -c roamgate -n __fish_use_subcommand -a doctor -d 'diagnose the installation and suggest fixes'",
    );
    expect(script).toContain(
      "complete -c roamgate -n '__fish_seen_subcommand_from url' -l qr",
    );
  });

  test("rejects unknown shells", async () => {
    cli = createTestCli();
    expect(await runCli(["completion", "tcsh"], cli.context)).toBe(EXIT_USAGE);
    expect(await runCli(["completion", "bash"], cli.context)).toBe(EXIT_OK);
  });
});
