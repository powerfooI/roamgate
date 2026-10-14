import { homedir } from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  type CaptureCommand,
  defaultCaptureCommand,
  defaultRunCommand,
  type RunCommand,
} from "../config/service-manager";

/** Exit codes shared by management commands. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Returned by a command that hands control to the server listener. */
export const CONTINUE_TO_SERVER = "continue-to-server";

export type CommandResult = number | typeof CONTINUE_TO_SERVER;

/** Invalid arguments: reported with a usage hint and EXIT_USAGE. */
export class UsageError extends Error {}

export interface CliRuntime {
  platform: string;
  arch: string;
  homeDir: string;
  appDataDir?: string;
  execPath: string;
  argv: string[];
  uid?: number;
  env: Record<string, string | undefined>;
}

export interface CliContext {
  version: string;
  runtime: CliRuntime;
  runCommand: RunCommand;
  /** Runs a command and returns its standard output, for status queries. */
  captureCommand: CaptureCommand;
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface CliCommand {
  name: string;
  /** One line for `roamgate --help`. */
  summary: string;
  /** Subcommand words offered by shell completion. */
  actions?: readonly string[];
  /** Flags offered by shell completion. */
  flags?: readonly string[];
  help: () => string;
  run: (args: string[], context: CliContext) => Promise<CommandResult>;
}

export function currentRuntime(): CliRuntime {
  return {
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    appDataDir: process.env.APPDATA,
    execPath: process.execPath,
    argv: process.argv,
    uid: process.getuid?.(),
    env: process.env,
  };
}

export function defaultCliContext(version: string): CliContext {
  return {
    version,
    runtime: currentRuntime(),
    runCommand: defaultRunCommand,
    captureCommand: defaultCaptureCommand,
    log: console.log,
    error: console.error,
  };
}

/** True for `--help`, `-h` or a leading `help` word. */
export function wantsHelp(args: readonly string[]): boolean {
  return args[0] === "help" || args.includes("--help") || args.includes("-h");
}

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

/** Strict flag parsing whose errors become usage errors. */
export function parseCommandArgs<const Options extends OptionsConfig>(
  args: string[],
  options: Options,
  maxPositionals = 0,
) {
  let parsed: ReturnType<typeof parseArgs<{ options: Options }>>;
  try {
    parsed = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: true,
    }) as ReturnType<typeof parseArgs<{ options: Options }>>;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const positionals = (parsed as { positionals: string[] }).positionals;
  if (positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument: ${positionals[maxPositionals]}`);
  }
  return { values: parsed.values, positionals };
}

export function printJson(context: CliContext, value: unknown): void {
  context.log(JSON.stringify(value, null, 2));
}

/** Show a home-relative path in human output. */
export function displayPath(path: string, runtime: CliRuntime): string {
  if (runtime.platform === "win32") return path;
  return path === runtime.homeDir || path.startsWith(`${runtime.homeDir}/`)
    ? `~${path.slice(runtime.homeDir.length)}`
    : path;
}

/** Whether this process is the standalone binary rather than `bun src/index.ts`. */
export function isStandaloneBinary(runtime: CliRuntime): boolean {
  const executable = runtime.execPath.split(/[\\/]/).pop()?.toLowerCase();
  return (
    executable !== "bun" &&
    executable !== "bun.exe" &&
    !(runtime.argv[1] ?? "").endsWith("src/index.ts")
  );
}
