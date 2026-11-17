import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import { gitShellCommandArgv } from "./git-shell";

/**
 * GitLab through `glab api` on the checkout's host, as the PR/MR card does:
 * the user's own glab login, over the connection's SSH master remotely. A
 * token is only ever sent to glab's default host, or to a host glab has a
 * login of its own for.
 */

const TIMEOUT_MS = 30_000;

export type GlabContext = {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: (
    argv: string[],
    timeoutMs: number,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

/** Variables that make glab use one token for every host. */
const TOKEN_VARIABLES = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];

/** How long what glab knows of a host is remembered. */
const HOST_CHECK_TTL_MS = 5 * 60_000;

/** What glab said of each host, by the process runner that asked it. */
const hostChecks = new WeakMap<
  GlabContext["runProcessWithCodeTimeout"],
  Map<string, { until: number; access: Promise<{ ownLogin: boolean }> }>
>();

/**
 * Prints glab's default host, and `login` when glab has a token of its
 * own for HOST (as readCheckoutScript tells logins): never the token.
 */
export function glabHostScript(
  root: string,
  host: string,
  shQuote: (value: string) => string,
): string {
  return [
    `{ cd ${shQuote(root)} 2>/dev/null || cd; }`,
    `command -v glab >/dev/null 2>&1 || exit 127`,
    `g=$(GLAB_NO_PROMPT=1 glab config get host 2>/dev/null)`,
    `printf 'glab %s\\n' "$g"`,
    `token() { (unset ${TOKEN_VARIABLES.join(" ")}; GLAB_NO_PROMPT=1 glab config get token --host "$1" 2>/dev/null); }`,
    `t=$(token ${shQuote(host)})`,
    `[ -n "$t" ] && [ "$t" != "$(token roamgate.invalid)" ] && printf 'login\\n'`,
    `exit 0`,
  ].join("\n");
}

function hostName(value: string): string {
  return value
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * Whether a GitLab host may be asked from the checkout's host, and with
 * which token. A token in the environment (GITLAB_TOKEN and the like), or
 * one in glab's config for no host in particular, answers for any host:
 * only glab's default host gets it. Another host is asked only when glab
 * has a login of its own for it, with the environment's tokens removed;
 * any other host is refused before glab runs, so that a merge request URL
 * cannot send the user's token anywhere.
 */
export async function glabHostAccess(
  context: GlabContext,
  host: string,
): Promise<{ ownLogin: boolean }> {
  let checks = hostChecks.get(context.runProcessWithCodeTimeout);
  if (!checks) {
    checks = new Map();
    hostChecks.set(context.runProcessWithCodeTimeout, checks);
  }
  const key = `${context.host ?? ""}\n${context.root}\n${host.toLowerCase()}`;
  const known = checks.get(key);
  if (known && known.until > Date.now()) return known.access;
  const entry = {
    until: Number.POSITIVE_INFINITY,
    access: checkGlabHost(context, host),
  };
  checks.set(key, entry);
  entry.access.then(
    () => {
      entry.until = Date.now() + HOST_CHECK_TTL_MS;
    },
    () => {
      if (checks.get(key) === entry) checks.delete(key);
    },
  );
  return entry.access;
}

async function checkGlabHost(
  context: GlabContext,
  host: string,
): Promise<{ ownLogin: boolean }> {
  const script = glabHostScript(context.root, host, context.shQuote);
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await context.runProcessWithCodeTimeout(
      context.host
        ? sshReadCommandArgv(context.host, script, [], "forge.gitlab")
        : gitShellCommandArgv(script),
      TIMEOUT_MS,
      context.host
        ? undefined
        : { cwd: existsSync(context.root) ? context.root : homedir() },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("glab is not installed on this host", { cause: error });
    throw error;
  }
  if (result.code === 127)
    throw new Error("glab is not installed on this host");
  if (result.code !== 0)
    throw new Error(
      `GitLab: cannot ask glab about ${host}: ${(result.stderr || "it failed").trim().slice(0, 200)}`,
    );
  const lines = result.stdout.split("\n").map((line) => line.trim());
  const defaultHost = hostName(
    lines.find((line) => line.startsWith("glab "))?.slice(5) ?? "",
  );
  const asked = host.toLowerCase();
  if (defaultHost && asked === defaultHost) return { ownLogin: false };
  if (lines.includes("login")) return { ownLogin: true };
  throw new Error(
    `GitLab: glab has no login for ${host} here; not sending it a token (glab auth login --hostname ${host})`,
  );
}

export async function glab(
  context: GlabContext,
  /**
   * ownLogin: a host other than glab's default, asked with its own login.
   * Unset: glabHostAccess tells, or refuses the host.
   */
  ref: { host: string; ownLogin?: boolean },
  /** POST only for GraphQL queries: nothing here writes. */
  method: "GET" | "POST",
  path: string,
  fields: [string, string, "raw" | "typed"][] = [],
  paginate = method === "GET",
): Promise<unknown> {
  if (ref.ownLogin === undefined)
    ref = { host: ref.host, ...(await glabHostAccess(context, ref.host)) };
  const argv = [
    "glab",
    "api",
    "--hostname",
    ref.host,
    "--method",
    method,
    ...(paginate ? ["--paginate"] : []),
    path,
    ...fields.flatMap(([key, value, kind]) => [
      kind === "raw" ? "-f" : "-F",
      `${key}=${value}`,
    ]),
  ];
  const env = { GLAB_NO_PROMPT: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
  let result: { code: number; stdout: string; stderr: string };
  if (context.host) {
    const unset = ref.ownLogin
      ? `env ${TOKEN_VARIABLES.map((name) => `-u ${name}`).join(" ")} `
      : "";
    // `glab api` names its project: a removed checkout runs it from home.
    const command = `{ cd ${context.shQuote(context.root)} 2>/dev/null || cd; } && ${unset}${Object.entries(
      env,
    )
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")} ${argv.map(context.shQuote).join(" ")}`;
    result = await context.runProcessWithCodeTimeout(
      method === "GET"
        ? sshReadCommandArgv(context.host, command, [], "forge.gitlab")
        : sshCommandArgv(context.host, command, [], "forge.gitlab"),
      TIMEOUT_MS,
    );
  } else {
    // A missing cwd fails the spawn with ENOENT too, as a missing glab
    // would: a removed checkout runs it from home instead.
    const cwd = existsSync(context.root) ? context.root : homedir();
    try {
      result = await context.runProcessWithCodeTimeout(argv, TIMEOUT_MS, {
        cwd,
        env: ref.ownLogin
          ? {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([name]) => !TOKEN_VARIABLES.includes(name),
                ),
              ),
              ...env,
            }
          : { ...process.env, ...env },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("glab is not installed on this host", {
          cause: error,
        });
      throw error;
    }
  }
  if (result.code === 127)
    throw new Error("glab is not installed on this host");
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || "GitLab request failed")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" ")
      .slice(0, 300);
    throw new Error(`GitLab: ${message}`);
  }
  const text = result.stdout.trim();
  if (!text) return null;
  if (!paginate) return JSON.parse(text);
  // --paginate prints one JSON array per page back to back.
  const pages = parseJsonPages(text);
  if (pages.length === 1) return pages[0];
  if (!pages.every(Array.isArray))
    throw new Error("GitLab: unexpected answer to a paged request");
  return (pages as unknown[][]).flat();
}

/**
 * The JSON values printed back to back, as `glab api --paginate` prints
 * its pages: each top-level array or object is cut out by its brackets,
 * skipping those inside strings, and parsed on its own.
 */
export function parseJsonPages(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      // A bare string or number on its own is not a page.
      if (depth === 0) return [JSON.parse(text)];
      inString = true;
    } else if (char === "[" || char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "]" || char === "}") {
      depth--;
      if (depth < 0) throw new Error("GitLab: malformed answer");
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(char)) return [JSON.parse(text)];
  }
  if (depth !== 0 || inString) throw new Error("GitLab: truncated answer");
  return values;
}

/** The host and project path a Git remote URL names. */
export function remoteProject(
  url: string,
): { host: string; project: string } | null {
  const full =
    /^(?:ssh|git\+ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(
      url,
    );
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(url);
  // C:\path is a Windows path, not host C.
  const match = full ?? (scp && !/^[a-z]:[\\/]/i.test(url) ? scp : null);
  if (!match) return null;
  const project = match[2]!
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!project.includes("/") || project.startsWith("~")) return null;
  return { host: match[1]!.toLowerCase(), project };
}
