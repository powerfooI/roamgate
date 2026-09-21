import { sshCommandArgv } from "../bridge/ssh-command";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { findHerdrBinary } from "./bootstrap";

const CLI_TIMEOUT_MS = 5_000;
const MAX_STATUS_LENGTH = 64 * 1024;

type IntegrationVersion = {
  state: "current" | "outdated";
  installed_version: number;
  available_version?: number;
};

function parseIntegrationVersions(stdout: string) {
  const versions = new Map<string, IntegrationVersion>();
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const target = /^([a-z][a-z0-9_-]*): /.exec(line)?.[1].replaceAll("-", "_");
    if (!target) continue;
    if (seen.has(target)) {
      versions.delete(target);
      continue;
    }
    seen.add(target);
    const match =
      /^[a-z][a-z0-9_-]*: (?:current \(v(\d+)\)|outdated \(v(\d+) < v(\d+)\))(?: \([^\r\n]*\))?$/.exec(
        line,
      );
    if (!match) continue;
    const installed = Number(match[1] ?? match[2]);
    const available = match[3] === undefined ? undefined : Number(match[3]);
    if (
      !Number.isSafeInteger(installed) ||
      (available !== undefined &&
        (!Number.isSafeInteger(available) || installed >= available))
    )
      continue;
    versions.set(target, {
      state: available === undefined ? "current" : "outdated",
      installed_version: installed,
      ...(available === undefined ? {} : { available_version: available }),
    });
  }
  return versions;
}

/** Supplement missing RPC metadata only from the selected host's matching CLI. */
export async function enrichIntegrationVersions(
  result: unknown,
  options: {
    sshHost?: string;
    ping: () => Promise<{ version?: unknown }>;
    run?: typeof runProcessWithCodeTimeout;
    findBinary?: typeof findHerdrBinary;
  },
): Promise<unknown> {
  if (
    !result ||
    typeof result !== "object" ||
    !("integrations" in result) ||
    !Array.isArray(result.integrations)
  )
    return result;
  const items = result.integrations;
  if (
    !items.every(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    )
  )
    return result;
  const needsVersions = (item: Record<string, unknown>) =>
    typeof item.target === "string" &&
    ((item.state === "current" && item.installed_version === undefined) ||
      (item.state === "outdated" &&
        (item.installed_version === undefined ||
          item.available_version === undefined)));
  if (!items.some(needsVersions)) return result;
  try {
    const run = options.run ?? runProcessWithCodeTimeout;
    const { version } = await options.ping();
    if (typeof version !== "string" || !version) return result;
    let stdout: string;
    if (options.sshHost) {
      const command =
        'if command -v herdr >/dev/null 2>&1; then bin=herdr; else bin="$HOME/.local/bin/herdr"; fi; "$bin" --version && "$bin" integration status';
      const output = await run(
        sshCommandArgv(options.sshHost, `bash -lc ${shQuote(command)}`),
        CLI_TIMEOUT_MS,
      );
      if (output.code !== 0 || output.stdout.length > MAX_STATUS_LENGTH)
        return result;
      const newline = output.stdout.indexOf("\n");
      if (
        newline < 0 ||
        output.stdout.slice(0, newline).trim() !== `herdr ${version}`
      )
        return result;
      stdout = output.stdout.slice(newline + 1);
    } else {
      const binary = (options.findBinary ?? findHerdrBinary)();
      if (!binary) return result;
      const cli = await run([binary, "--version"], CLI_TIMEOUT_MS);
      if (cli.code !== 0 || cli.stdout.trim() !== `herdr ${version}`)
        return result;
      const output = await run(
        [binary, "integration", "status"],
        CLI_TIMEOUT_MS,
      );
      if (output.code !== 0 || output.stdout.length > MAX_STATUS_LENGTH)
        return result;
      stdout = output.stdout;
    }
    const versions = parseIntegrationVersions(stdout);
    return {
      ...result,
      integrations: items.map((item) => {
        if (!needsVersions(item)) return item;
        const cli = versions.get(item.target.replaceAll("-", "_"));
        if (
          !cli ||
          cli.state !== item.state ||
          (item.installed_version !== undefined &&
            item.installed_version !== cli.installed_version) ||
          (item.available_version !== undefined &&
            cli.available_version !== undefined &&
            item.available_version !== cli.available_version)
        )
          return item;
        return {
          ...item,
          installed_version: item.installed_version ?? cli.installed_version,
          ...(item.available_version === undefined &&
          cli.available_version !== undefined
            ? { available_version: cli.available_version }
            : {}),
        };
      }),
    };
  } catch {
    // Missing binaries, SSH failures, and timeouts must not hide the RPC list.
    return result;
  }
}
