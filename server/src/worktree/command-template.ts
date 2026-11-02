import { sshCommandArgv } from "../bridge/ssh-command";
import { shQuote } from "../utils/process-utils";

/**
 * The environment variable each placeholder of a worktree command stands for.
 * Values never enter the command text: the script exports them first, and a
 * placeholder becomes a double-quoted expansion of its variable, so a branch
 * or path cannot be read as shell syntax whatever it contains.
 */
export const WORKTREE_COMMAND_VARIABLES = {
  path: "ROAMGATE_WORKTREE_PATH",
  branch: "ROAMGATE_WORKTREE_BRANCH",
  base: "ROAMGATE_WORKTREE_BASE",
  repo: "ROAMGATE_WORKTREE_REPO",
} as const;

export type WorktreeCommandValue = keyof typeof WORKTREE_COMMAND_VARIABLES;

const PLACEHOLDER = /\{(path|branch|base|repo|force)\}/g;

/**
 * Why a command template is refused, or undefined when it is usable. A
 * placeholder inside quotes is refused: Roamgate quotes it itself, and inside
 * the user's quotes the expansion would split or stay literal.
 */
export function worktreeCommandTemplateError(
  template: string,
): string | undefined {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === "\\") {
      if (/^\{(path|branch|base|repo|force)\}/.test(template.slice(index + 1)))
        return "Remove the escape before the placeholder: Roamgate quotes placeholders itself.";
      index++;
      continue;
    } else if (quote === '"') {
      if (char === '"') quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "{") continue;
    const match = /^\{(path|branch|base|repo|force)\}/.exec(
      template.slice(index),
    );
    if (match && quote)
      return `Remove the quotes around {${match[1]}}: Roamgate quotes placeholders itself.`;
  }
  return quote ? "The command has an unterminated quote." : undefined;
}

/** Quotes a path for the shell, leaving a leading `~/` to the host's $HOME. */
export function shQuotePath(path: string) {
  return path.startsWith("~/")
    ? `"$HOME"/${shQuote(path.slice(2))}`
    : shQuote(path);
}

/**
 * Builds the script that runs a worktree command template: exports the
 * values, then the template with each placeholder replaced by its variable.
 * `{force}` is `--force` or nothing. Throws for a template
 * {@link worktreeCommandTemplateError} refuses.
 */
export function worktreeCommandScript(
  template: string,
  values: Partial<Record<WorktreeCommandValue, string>> & { force?: boolean },
) {
  const error = worktreeCommandTemplateError(template);
  if (error) throw new Error(error);
  const exports = (
    Object.keys(WORKTREE_COMMAND_VARIABLES) as WorktreeCommandValue[]
  )
    .filter((name) => values[name] !== undefined)
    .map((name) => {
      const value = values[name] as string;
      if (value.includes("\0"))
        throw new Error(`Worktree ${name} contains a NUL byte.`);
      return `export ${WORKTREE_COMMAND_VARIABLES[name]}=${
        name === "path" ? shQuotePath(value) : shQuote(value)
      }`;
    });
  const command = template.replace(PLACEHOLDER, (_, name: string) => {
    if (name === "force") return values.force ? "--force" : "";
    const variable = WORKTREE_COMMAND_VARIABLES[name as WorktreeCommandValue];
    if (values[name as WorktreeCommandValue] === undefined)
      throw new Error(`{${name}} is not available in this command.`);
    return `"$${variable}"`;
  });
  return { exports: exports.join("; "), command };
}

/** Characters that are shell syntax, refused in branch names. */
const SHELL_SYNTAX = /[\s$`'"\\;|&<>(){}!*?[\]~^:]/;

/**
 * Throws unless `branch` is a valid git branch name (the rules of
 * `git check-ref-format --branch`) without shell syntax characters, so no
 * configured command or hook can misread it.
 */
export function validateWorktreeBranchName(branch: string) {
  const invalid = (why: string) =>
    new Error(`Invalid branch name ${JSON.stringify(branch)}: ${why}.`);
  if (!branch) throw invalid("it is empty");
  if (branch.length > 255) throw invalid("it is longer than 255 characters");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them
  if (/[\x00-\x1f\x7f]/.test(branch))
    throw invalid("it has control characters");
  if (SHELL_SYNTAX.test(branch))
    throw invalid("it has spaces or shell syntax characters");
  if (branch.startsWith("-")) throw invalid("it starts with '-'");
  if (branch === "@" || branch.includes("@{"))
    throw invalid("it is '@' or has '@{'");
  if (branch.includes("..")) throw invalid("it has '..'");
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//"))
    throw invalid("it has an empty path component");
  if (branch.endsWith(".")) throw invalid("it ends with '.'");
  for (const part of branch.split("/"))
    if (part.startsWith(".") || part.endsWith(".lock"))
      throw invalid("a component starts with '.' or ends with '.lock'");
  return branch;
}

/**
 * The first program a template runs (and its git subcommand), when the
 * template starts with a plain word; undefined when Roamgate cannot tell.
 */
export function worktreeCommandProgram(
  template: string,
): { program: string; subcommand?: string } | undefined {
  const match =
    /^\s*([A-Za-z0-9_./+-]+)(?=\s|$)(?:\s+([A-Za-z0-9_.+-]+)(?=\s|$))?/.exec(
      template,
    );
  if (!match) return undefined;
  const program = match[1];
  const subcommand =
    program === "git" && match[2] && !match[2].startsWith("-")
      ? match[2]
      : undefined;
  return subcommand ? { program, subcommand } : { program };
}

/**
 * A script that exits 127 when the template's program (or git subcommand,
 * builtin, installed or alias) is missing, 0 otherwise. Checked apart from
 * the command, so an exit 127 from inside the command is reported as a
 * failure instead of being taken for a missing install.
 */
export function worktreeCommandProbeScript(template: string) {
  const program = worktreeCommandProgram(template);
  if (!program) return undefined;
  const lines = [
    `command -v -- ${shQuote(program.program)} >/dev/null 2>&1 || exit 127`,
  ];
  if (program.subcommand)
    lines.push(
      `git --list-cmds=main,others,alias 2>/dev/null | grep -qxF -- ${shQuote(
        program.subcommand,
      )} || exit 127`,
    );
  return lines.join("; ");
}

/**
 * The argv that runs a worktree script with `sh` on the host: the login
 * shell locally, `sh -c` over ssh whatever the remote login shell is.
 */
export function worktreeShellArgv(host: string | undefined, script: string) {
  return host
    ? sshCommandArgv(host, `sh -c ${shQuote(script)}`)
    : ["sh", "-lc", script];
}

type RunWorktreeProcess = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The install check is a `command -v`; it should never take long. */
export const WORKTREE_COMMAND_PROBE_TIMEOUT_MS = 30_000;

/**
 * Checks, apart from the command itself, whether the template's program is
 * installed on the host. Resolves to a sentence saying what is missing
 * (Roamgate then leaves the work to Herdr and reports it), or null when it is
 * installed or Roamgate cannot tell, in which case any failure of the command
 * is reported as one.
 */
export async function missingWorktreeCommand({
  template,
  host,
  runProcess,
}: {
  template: string;
  host?: string;
  runProcess: RunWorktreeProcess;
}): Promise<string | null> {
  const probe = worktreeCommandProbeScript(template);
  if (!probe) return null;
  const program = worktreeCommandProgram(template)!;
  const name = program.subcommand
    ? `${program.program} ${program.subcommand}`
    : program.program;
  const where = host ? `on ${host}` : "on this machine";
  try {
    const run = await runProcess(
      worktreeShellArgv(host, probe),
      WORKTREE_COMMAND_PROBE_TIMEOUT_MS,
    );
    return run.code === 127 ? `${name} is not installed ${where}.` : null;
  } catch (error) {
    // No sh to run it with (a Windows machine without one).
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return `sh is not available ${where}.`;
    throw error;
  }
}
