import { runPluginCommand } from "../config/plugin-command";
import { serverOptionsHelp } from "../config/server-config";
import {
  runServiceCommand,
  SERVICE_COMMAND_CONTINUE,
} from "../config/service-manager";
import { runHerdrCommand } from "../herdr/cli";
import { authCommand } from "./auth";
import {
  type CliCommand,
  type CliContext,
  type CommandResult,
  CONTINUE_TO_SERVER,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  wantsHelp,
} from "./command";
import { createCompletionCommand } from "./completion";
import { configCommand } from "./config";
import { createConnectionsCommand } from "./connections";
import { createDoctorCommand } from "./doctor";
import { createPushCommand } from "./push";
import { serviceRuntime } from "./service-context";
import { runServiceLogs } from "./service-logs";
import { createUpdateCommand, rollbackCommand } from "./update";
import { urlCommand } from "./url";

// The existing command families keep their own parsers, help and exit codes;
// the router only adds dispatch, discovery and completion metadata.
const serviceCommand: CliCommand = {
  name: "service",
  summary: "install and manage the Roamgate user service",
  actions: ["install", "status", "restart", "reload", "uninstall", "logs"],
  flags: ["--force", "--follow", "--lines"],
  help: () => "Run `roamgate service --help`.",
  async run(args, context) {
    if (args[0] === "logs" && !wantsHelp(args.slice(1)))
      return runServiceLogs(args.slice(1), context);
    const result = runServiceCommand(["service", ...args], {
      runtime: serviceRuntime(context.runtime),
      runCommand: context.runCommand,
      log: context.log,
      error: context.error,
    });
    if (result === SERVICE_COMMAND_CONTINUE) return CONTINUE_TO_SERVER;
    return result ?? EXIT_FAILURE;
  },
};

const herdrCommand: CliCommand = {
  name: "herdr",
  summary: "install, start and check the local Herdr server",
  actions: ["setup", "status"],
  help: () => "Run `roamgate herdr --help`.",
  async run(args, context) {
    return (
      (await runHerdrCommand(["herdr", ...args], context.version, {
        log: context.log,
        error: context.error,
      })) ?? EXIT_FAILURE
    );
  },
};

const pluginCommand: CliCommand = {
  name: "plugin",
  summary: "actions and panel used by the Herdr plugin",
  actions: [
    "start",
    "restart",
    "status",
    "url",
    "version",
    "uninstall",
    "panel",
  ],
  help: () => "Run `roamgate plugin --help`.",
  async run(args, context) {
    return (
      (await runPluginCommand(
        ["plugin", ...args],
        context.version,
        context.runtime.execPath,
      )) ?? EXIT_FAILURE
    );
  },
};

const DELEGATED_HELP = new Set(["service", "herdr", "plugin"]);

export function cliCommands(): CliCommand[] {
  const commands: CliCommand[] = [
    serviceCommand,
    herdrCommand,
    createDoctorCommand(),
    urlCommand,
    configCommand,
    authCommand,
    createConnectionsCommand(),
    createPushCommand(),
    createUpdateCommand(),
    rollbackCommand,
    pluginCommand,
  ];
  commands.push(createCompletionCommand(() => commands));
  return commands;
}

export function topLevelHelp(commands: readonly CliCommand[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.summary}`,
  );
  return `Roamgate — Web and PWA client for Herdr

Usage: roamgate [options]              run the server
       roamgate <command> [arguments]  manage an installation

Commands:
${lines.join("\n")}

Run \`roamgate <command> --help\` or \`roamgate help <command>\` for details.

${serverOptionsHelp()}`;
}

/**
 * Dispatch a management command. Returns null when argv belongs to the server
 * (no arguments or only flags), so the caller starts the listener.
 */
export async function runCli(
  argv: string[],
  context: CliContext,
  commands: readonly CliCommand[] = cliCommands(),
): Promise<CommandResult | null> {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) return null;
  if (first === "help") {
    const topic = argv[1];
    if (topic === undefined) {
      context.log(topLevelHelp(commands));
      return EXIT_OK;
    }
    const command = commands.find((entry) => entry.name === topic);
    if (!command) {
      context.error(`roamgate: unknown command: ${topic}`);
      return EXIT_USAGE;
    }
    if (DELEGATED_HELP.has(command.name))
      return command.run(["--help"], context);
    context.log(command.help());
    return EXIT_OK;
  }
  const command = commands.find((entry) => entry.name === first);
  if (!command) {
    context.error(`roamgate: unknown command: ${first}`);
    context.error("Run `roamgate --help` for the list of commands.");
    return EXIT_USAGE;
  }
  try {
    return await command.run(argv.slice(1), context);
  } catch (error) {
    context.error(`roamgate ${command.name}: ${(error as Error).message}`);
    if (error instanceof UsageError) {
      context.error(`Run \`roamgate ${command.name} --help\` for usage.`);
      return EXIT_USAGE;
    }
    return EXIT_FAILURE;
  }
}
