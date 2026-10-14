import { isAbsolute } from "node:path";
import { validateSshDestination } from "../bridge/ssh-command";
import {
  assertValidAuthPassword,
  assertValidAuthPin,
} from "../config/auth-token";
import { replaceDataFile } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import {
  parseServiceEnvironment,
  prepareServiceAccess,
} from "../config/service-manager";
import { normalizeUpdateBaseUrl } from "../http/update";
import { parseTaskNotificationSource } from "../notifications/herdr-notification-listener";
import { assertValidPushSubject } from "../notifications/web-push";
import { parseLogLevel } from "../utils/logger";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";
import {
  locateServiceConfig,
  readServiceSetup,
  restartRunningService,
  type ServiceConfigFile,
  serviceStatus,
  type ServiceSetup,
} from "./service-context";

interface Setting {
  key: string;
  description: string;
  /** The value the server uses when the file does not set one. */
  fallback?: string;
  secret?: boolean;
  validate?: (value: string) => void;
  /**
   * The server refuses to start with an invalid value, so it is checked on
   * every write. Other settings are checked strictly only when they change, so
   * an existing value the server tolerates never blocks unrelated edits.
   */
  startup?: boolean;
}

function assertFlag(value: string) {
  if (value !== "0" && value !== "1") throw new Error("must be 0 or 1");
}

function assertPositiveInteger(value: string) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("must be a positive integer");
}

function assertAbsolutePath(value: string) {
  if (!isAbsolute(value)) throw new Error("must be an absolute path");
}

export const SETTINGS: readonly Setting[] = [
  {
    key: "HOST",
    description: "listen address",
    fallback: "127.0.0.1",
    validate: (value) => {
      if (!/^[A-Za-z0-9.:_-]+$/.test(value))
        throw new Error("must be a host name or IP address");
    },
  },
  {
    key: "PORT",
    description: "listen port",
    fallback: "8787",
    validate: (value) => {
      if (
        !/^[0-9]+$/.test(value) ||
        Number(value) < 1 ||
        Number(value) > 65_535
      )
        throw new Error("must be a port number from 1 to 65535");
    },
  },
  {
    key: "ROAMGATE_PASSWORD",
    description: "fixed login password instead of a generated token",
    secret: true,
    validate: assertValidAuthPassword,
  },
  {
    key: "ROAMGATE_PIN",
    description: "6..12 digit convenience login (private networks only)",
    secret: true,
    validate: assertValidAuthPin,
  },
  {
    key: "ROAMGATE_TLS_CERT",
    description: "PEM certificate chain for native HTTPS",
    validate: assertAbsolutePath,
  },
  {
    key: "ROAMGATE_TLS_KEY",
    description: "PEM private key for native HTTPS",
    validate: assertAbsolutePath,
  },
  {
    key: "ROAMGATE_LOG_LEVEL",
    description: "error|warn|info|debug",
    fallback: "info",
    validate: parseLogLevel,
    startup: true,
  },
  {
    key: "ROAMGATE_NOTIFICATION_SOURCE",
    description: "herdr|status task alert source",
    fallback: "herdr",
    validate: (value) => parseTaskNotificationSource(value),
    startup: true,
  },
  { key: "HERDR_SOCKET_PATH", description: "Herdr control socket" },
  { key: "HERDR_CLIENT_SOCKET_PATH", description: "Herdr render socket" },
  {
    key: "HERDR_SSH_HOST",
    description: "remote Herdr over SSH (user@host)",
    validate: validateSshDestination,
    startup: true,
  },
  { key: "HERDR_SESSION", description: "named Herdr session" },
  {
    key: "ROAMGATE_UPDATE_BASE_URL",
    description: "latest-release mirror directory",
    validate: normalizeUpdateBaseUrl,
  },
  {
    key: "ROAMGATE_DISABLE_UPDATE_CHECK",
    description: "1 disables update checks",
    validate: assertFlag,
  },
  {
    key: "ROAMGATE_ALLOW_FILE_REVEAL",
    description: "1 allows revealing files on the host",
    validate: assertFlag,
  },
  {
    key: "ROAMGATE_UPLOAD_MAX_BYTES",
    description: "maximum terminal upload size",
    validate: assertPositiveInteger,
  },
  {
    key: "ROAMGATE_UPLOAD_RETENTION_HOURS",
    description: "staged upload retention",
    validate: assertPositiveInteger,
  },
  {
    key: "ROAMGATE_WEB_PUSH_SUBJECT",
    description: "VAPID contact; empty disables Web Push",
    validate: (value) => {
      if (value) assertValidPushSubject(value);
    },
  },
  {
    key: "ROAMGATE_WEB_PUSH_PATH",
    description: "Web Push registry file",
    validate: assertAbsolutePath,
  },
  {
    key: "ROAMGATE_CONNECTIONS_PATH",
    description: "connection profile registry file",
    validate: assertAbsolutePath,
  },
  {
    key: "ROAMGATE_SETTINGS_PATH",
    description: "GUI settings file",
    validate: assertAbsolutePath,
  },
];

const SETTINGS_BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));

/** Accept legacy HERDR_GUI_* spellings, but always write the Roamgate name. */
function resolveSetting(key: string): Setting {
  const canonical = key.startsWith("HERDR_GUI_")
    ? `ROAMGATE_${key.slice("HERDR_GUI_".length)}`
    : key;
  const setting = SETTINGS_BY_KEY.get(canonical);
  if (!setting) {
    throw new UsageError(
      `unknown setting: ${key} (run \`roamgate config show\` for the list; edit the file directly for other variables)`,
    );
  }
  return setting;
}

function legacyAlias(key: string): string | undefined {
  return key.startsWith("ROAMGATE_")
    ? `HERDR_GUI_${key.slice("ROAMGATE_".length)}`
    : undefined;
}

function effectiveValue(env: Record<string, string>, key: string) {
  return key.startsWith("ROAMGATE_")
    ? roamgateEnv(key.slice("ROAMGATE_".length), env)
    : env[key];
}

const BARE_VALUE = /^[A-Za-z0-9_./:@%+,=-]*$/;

/**
 * Quote so systemd's EnvironmentFile, launchd's sh source and the Windows
 * parser all read the same value: single quotes are literal everywhere, and
 * double quotes are literal when the value has no $, `, \\ or ".
 */
export function encodeEnvironmentValue(value: string): string {
  if (/[\0\r\n]/.test(value))
    throw new Error("values must be a single line without NUL characters");
  if (value !== "" && BARE_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!/[$`\\"]/.test(value)) return `"${value}"`;
  throw new Error(
    "values containing ' together with $, `, \\ or \" cannot be quoted for every service manager; edit the file directly",
  );
}

function assignmentPattern(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
}

/**
 * Apply updates (null removes) while preserving comments and order. A new
 * value replaces the last assignment, lands below its commented placeholder,
 * or is appended; earlier duplicate assignments are removed.
 */
export function updateEnvironmentFile(
  contents: string,
  updates: ReadonlyMap<string, string | null>,
): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  let lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const [key, value] of updates) {
    const pattern = assignmentPattern(key);
    const assigned = lines.flatMap((line, index) =>
      pattern.test(line) ? [index] : [],
    );
    const replacement =
      value === null ? null : `${key}=${encodeEnvironmentValue(value)}`;
    if (replacement !== null && assigned.length > 0) {
      lines[assigned.at(-1)!] = replacement;
      assigned.pop();
    }
    const removed = new Set(assigned);
    lines = lines.filter((_, index) => !removed.has(index));
    if (replacement === null || lines.includes(replacement)) continue;
    const placeholder = new RegExp(`^\\s*#\\s*(?:export\\s+)?${key}\\s*=`);
    const placeholderIndex = lines.findLastIndex((line) =>
      placeholder.test(line),
    );
    if (placeholderIndex >= 0)
      lines.splice(placeholderIndex + 1, 0, replacement);
    else lines.push(replacement);
  }
  return lines.length ? `${lines.join(newline)}${newline}` : "";
}

/**
 * Reject a candidate file the service would refuse to start with. Settings in
 * strictKeys also get the CLI's stricter per-setting checks.
 */
function validateCandidate(
  file: ServiceConfigFile,
  contents: string,
  strictKeys: ReadonlySet<string>,
) {
  const env = parseServiceEnvironment(
    contents,
    file.configPath,
    file.platform,
    file.homeDir,
  );
  for (const setting of SETTINGS) {
    if (!setting.validate) continue;
    if (!setting.startup && !strictKeys.has(setting.key)) continue;
    const value = effectiveValue(env, setting.key);
    if (value === undefined || value === "") continue;
    try {
      setting.validate(value);
    } catch (error) {
      throw new Error(`${setting.key}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  prepareServiceAccess(file.configPath, contents, file.platform, file.homeDir);
  return env;
}

/** Settings whose effective value differs between two parsed files. */
function changedSettings(
  before: Record<string, string> | null,
  after: Record<string, string>,
): Set<string> {
  return new Set(
    SETTINGS.filter(
      (setting) =>
        before === null ||
        effectiveValue(before, setting.key) !==
          effectiveValue(after, setting.key),
    ).map((setting) => setting.key),
  );
}

function configHelp(): string {
  return `Read and change the managed service's environment file.

Usage:
  roamgate config show [--reveal] [--json]
  roamgate config get <KEY>
  roamgate config set <KEY=VALUE>... [--restart]
  roamgate config unset <KEY>... [--restart]
  roamgate config edit [--restart]
  roamgate config path

Changes are validated as a whole before the file is replaced, so the service
never receives a configuration it would refuse to start with. Changed settings
get stricter checks; existing values the server accepts are left alone. Comments and
ordering are preserved. A running service keeps its old settings until it
restarts; --restart restarts it when it is running.

Set paired values in one command, for example
  roamgate config set ROAMGATE_TLS_CERT=/path/cert.pem ROAMGATE_TLS_KEY=/path/key.pem

Use KEY=- to read a value from standard input instead of the command line,
which keeps secrets such as ROAMGATE_PASSWORD out of shell history:
  printf '%s' "$PASSWORD" | roamgate config set ROAMGATE_PASSWORD=-

Shell flags and exported variables apply only to foreground \`roamgate\` runs;
this command manages the file the service reads.
`;
}

async function readStdinValue(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  return text.replace(/\r?\n$/, "");
}

function writeAndReport(
  context: CliContext,
  setup: ServiceSetup,
  next: string,
  changed: ReadonlySet<string>,
  restart: boolean,
): number {
  validateCandidate(setup, next, changed);
  replaceDataFile(setup.configPath, next);
  context.log(`Updated ${displayPath(setup.configPath, context.runtime)}`);
  return applyChange(context, restart);
}

function applyChange(context: CliContext, restart: boolean): number {
  if (restart) {
    const code = restartRunningService(context);
    if (code === null) {
      context.log("The service is not running; changes apply when it starts.");
      return EXIT_OK;
    }
    if (code === 0) context.log("Restarted the service.");
    return code;
  }
  let active = false;
  try {
    active = serviceStatus(context).active;
  } catch {
    // Unsupported platforms have no managed service to remind about.
  }
  if (active)
    context.log(
      "The running service still uses the old values; run `roamgate service restart`.",
    );
  return EXIT_OK;
}

function editConfig(args: string[], context: CliContext): number {
  const { values } = parseCommandArgs(args, {
    restart: { type: "boolean" },
  });
  const file = locateServiceConfig(context.runtime);
  if (!file.configExists) replaceDataFile(file.configPath, file.contents);
  let before: Record<string, string> | null = null;
  try {
    before = parseServiceEnvironment(
      file.contents,
      file.configPath,
      file.platform,
      file.homeDir,
    );
  } catch {
    // Repairing a broken file is a reason to edit it; check everything after.
  }
  const editor =
    context.runtime.env.VISUAL ||
    context.runtime.env.EDITOR ||
    (context.runtime.platform === "win32" ? "notepad" : "vi");
  const code = context.runCommand([
    ...editor.split(/\s+/).filter(Boolean),
    file.configPath,
  ]);
  if (code !== 0) {
    context.error(`roamgate config: editor exited ${code}`);
    return EXIT_FAILURE;
  }
  const edited = locateServiceConfig(context.runtime);
  try {
    const after = parseServiceEnvironment(
      edited.contents,
      edited.configPath,
      edited.platform,
      edited.homeDir,
    );
    validateCandidate(edited, edited.contents, changedSettings(before, after));
  } catch (error) {
    context.error(
      `roamgate config: the edited file is invalid: ${(error as Error).message}`,
    );
    context.error(
      "The service would refuse to start; run `roamgate config edit` again to fix it.",
    );
    return EXIT_FAILURE;
  }
  if (edited.contents === file.contents) {
    context.log("No changes.");
    return EXIT_OK;
  }
  return applyChange(context, values.restart === true);
}

export const configCommand: CliCommand = {
  name: "config",
  summary: "show or change the service configuration",
  actions: ["show", "get", "set", "unset", "edit", "path"],
  flags: ["--reveal", "--json", "--restart"],
  help: configHelp,
  async run(args, context) {
    const action = args[0];
    if (wantsHelp(args) || action === undefined) {
      context.log(configHelp());
      return EXIT_OK;
    }
    const rest = args.slice(1);

    // path and edit only locate the file, so they still work when it is broken.
    if (action === "path") {
      parseCommandArgs(rest, {});
      context.log(locateServiceConfig(context.runtime).configPath);
      return EXIT_OK;
    }
    if (action === "edit") return editConfig(rest, context);

    const setup = readServiceSetup(context.runtime);

    if (action === "show") {
      const { values } = parseCommandArgs(rest, {
        reveal: { type: "boolean" },
        json: { type: "boolean" },
      });
      const known = new Set<string>();
      const rows = SETTINGS.map((setting) => {
        known.add(setting.key);
        const alias = legacyAlias(setting.key);
        if (alias) known.add(alias);
        const value = effectiveValue(setup.env, setting.key);
        const source =
          value !== undefined
            ? setup.env[setting.key] !== undefined
              ? "file"
              : "file (legacy name)"
            : setting.fallback !== undefined
              ? "default"
              : "unset";
        const shown =
          value === undefined
            ? setting.fallback
            : setting.secret && !values.reveal && value !== ""
              ? "(hidden)"
              : value;
        return { key: setting.key, value: shown, source, setting };
      });
      const other = Object.keys(setup.env).filter((key) => !known.has(key));
      if (values.json) {
        printJson(context, {
          path: setup.configPath,
          exists: setup.configExists,
          settings: Object.fromEntries(
            rows.map((row) => [
              row.key,
              { value: row.value ?? null, source: row.source },
            ]),
          ),
          other: values.reveal
            ? Object.fromEntries(other.map((key) => [key, setup.env[key]]))
            : other,
        });
        return EXIT_OK;
      }
      context.log(
        `${displayPath(setup.configPath, context.runtime)}${setup.configExists ? "" : " (not created yet; showing defaults)"}`,
      );
      context.log("");
      const width = Math.max(...rows.map((row) => row.key.length));
      for (const row of rows) {
        if (row.source === "unset") continue;
        const label = row.source === "file" ? "" : `  (${row.source})`;
        context.log(
          `  ${row.key.padEnd(width)}  ${row.value === "" ? "''" : row.value}${label}`,
        );
      }
      const unset = rows.filter((row) => row.source === "unset");
      if (unset.length) {
        context.log("");
        context.log("Not set:");
        for (const row of unset)
          context.log(`  ${row.key.padEnd(width)}  ${row.setting.description}`);
      }
      if (other.length) {
        context.log("");
        context.log(`Other variables: ${other.join(", ")}`);
      }
      return EXIT_OK;
    }

    if (action === "get") {
      const { positionals } = parseCommandArgs(rest, {}, 1);
      if (positionals.length !== 1)
        throw new UsageError("config get needs one KEY");
      const setting = resolveSetting(positionals[0]);
      const value = effectiveValue(setup.env, setting.key);
      if (value === undefined) {
        if (setting.fallback === undefined) return EXIT_FAILURE;
        context.log(setting.fallback);
        return EXIT_OK;
      }
      context.log(value);
      return EXIT_OK;
    }

    if (action === "set" || action === "unset") {
      const { values, positionals } = parseCommandArgs(
        rest,
        { restart: { type: "boolean" } },
        Number.POSITIVE_INFINITY,
      );
      if (positionals.length === 0)
        throw new UsageError(
          action === "set"
            ? "config set needs KEY=VALUE"
            : "config unset needs a KEY",
        );
      const updates = new Map<string, string | null>();
      let readFromStdin = false;
      for (const argument of positionals) {
        let key = argument;
        let value: string | null = null;
        if (action === "set") {
          const separator = argument.indexOf("=");
          if (separator <= 0)
            throw new UsageError(`expected KEY=VALUE, got: ${argument}`);
          key = argument.slice(0, separator);
          value = argument.slice(separator + 1);
        }
        const setting = resolveSetting(key);
        if (value === "-") {
          if (readFromStdin)
            throw new UsageError(
              "only one value can be read from standard input",
            );
          readFromStdin = true;
          value = await readStdinValue();
        } else if (setting.secret && value) {
          context.error(
            `Warning: ${setting.key} on the command line can be saved in shell history; prefer ${setting.key}=-`,
          );
        }
        if (value !== null && value !== "" && setting.validate) {
          try {
            setting.validate(value);
          } catch (error) {
            throw new UsageError(
              `${setting.key}: ${(error as Error).message}`,
              { cause: error },
            );
          }
        }
        updates.set(setting.key, value);
        // The legacy alias would shadow nothing once the new name exists, but
        // after an unset it would take effect again; remove both spellings.
        const alias = legacyAlias(setting.key);
        if (alias && (value === null || setup.env[alias] !== undefined))
          updates.set(alias, null);
      }
      const next = updateEnvironmentFile(setup.contents, updates);
      if (next === setup.contents && setup.configExists) {
        context.log("No changes.");
        return EXIT_OK;
      }
      return writeAndReport(
        context,
        setup,
        next,
        new Set(updates.keys()),
        values.restart === true,
      );
    }

    throw new UsageError(`unknown config action: ${action}`);
  },
};
