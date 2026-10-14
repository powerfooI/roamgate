import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureCommand, RunCommand } from "../config/service-manager";
import type { CliContext, CliRuntime } from "./command";

export interface TestCli {
  home: string;
  context: CliContext;
  output: string[];
  errors: string[];
  commands: string[][];
  /** The service environment file under the temporary home (Linux layout). */
  configPath: string;
  writeConfig: (contents: string) => void;
  cleanup: () => void;
}

/** A CLI context whose files, commands and output never leave a temp home. */
export function createTestCli(
  options: {
    runtime?: Partial<CliRuntime>;
    runCommand?: RunCommand;
    captureCommand?: CaptureCommand;
  } = {},
): TestCli {
  const home = mkdtempSync(join(tmpdir(), "roamgate-cli-test-"));
  const output: string[] = [];
  const errors: string[] = [];
  const commands: string[][] = [];
  const runtime: CliRuntime = {
    platform: "linux",
    arch: "x64",
    homeDir: home,
    execPath: join(home, "bin", "roamgate"),
    argv: [join(home, "bin", "roamgate"), "roamgate"],
    uid: 1000,
    env: {},
    ...options.runtime,
  };
  const configPath = join(home, ".config", "roamgate", "roamgate.env");
  return {
    home,
    output,
    errors,
    commands,
    configPath,
    context: {
      version: "1.2.3",
      runtime,
      runCommand: (argv, commandOptions) => {
        commands.push(argv);
        // Unknown commands fail like a missing service by default.
        return options.runCommand?.(argv, commandOptions) ?? 4;
      },
      captureCommand: (argv) => {
        commands.push(argv);
        return options.captureCommand?.(argv) ?? { code: 113, stdout: "" };
      },
      log: (message) => output.push(message),
      error: (message) => errors.push(message),
    },
    writeConfig(contents) {
      mkdirSync(join(home, ".config", "roamgate"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(configPath, contents, { mode: 0o600 });
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
