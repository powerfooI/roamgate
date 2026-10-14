import { spawnSync } from "node:child_process";
import { type CliRuntime, currentRuntime } from "../cli/command";
import {
  accessUrls,
  locateServiceConfig,
  readServiceAccess,
  readServiceSetup,
} from "../cli/service-context";

function capture(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  return {
    code: result.status ?? 1,
    out: result.stdout ?? "",
    err: result.error?.message ?? result.stderr ?? "",
  };
}

/** The service's local login URL, computed exactly as `roamgate url` does. */
export function serviceLoginUrl(
  runtime: CliRuntime = currentRuntime(),
): string {
  return accessUrls(readServiceAccess(readServiceSetup(runtime)), () => [])
    .local;
}

function urlText(): string {
  try {
    return serviceLoginUrl();
  } catch (error) {
    return `unavailable (${(error as Error).message})`;
  }
}

function printUrl(): number {
  const runtime = currentRuntime();
  try {
    const file = locateServiceConfig(runtime);
    if (!file.configExists) {
      console.error(
        `roamgate plugin: no service environment at ${file.configPath}, showing defaults`,
      );
    }
    console.log(serviceLoginUrl(runtime));
    return 0;
  } catch (error) {
    console.error(`roamgate plugin: ${(error as Error).message}`);
    return 1;
  }
}

function statusText(binary: string): string {
  const result = capture(binary, ["service", "status"]);
  if (result.code !== 0) return "not installed";
  return result.out.trim().split("\n")[0]?.trim() || "installed";
}

function panel(binary: string, version: string): Promise<number> {
  if (!process.stdin.isTTY) {
    console.log(`Status:  ${statusText(binary)}`);
    console.log(`URL:     ${urlText()}`);
    console.log(`Version: roamgate ${version}`);
    return Promise.resolve(0);
  }
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let done = false;
    function render(message = "") {
      const lines = [
        "Roamgate",
        "",
        `Status:  ${statusText(binary)}`,
        `URL:     ${urlText()}`,
        `Version: roamgate ${version}`,
        "",
        "[s] start  [r] restart  [u] uninstall  [q] close",
      ];
      if (message) lines.push("", message);
      process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${lines.join("\r\n")}\r\n`);
    }
    const cleanup = () => {
      if (done) return;
      done = true;
      process.stdout.write("\x1b[?25h\x1b[0m\n");
      stdin.setRawMode(false);
      stdin.pause();
      resolve(0);
    };
    // Restore the terminal when the host closes or signals the panel.
    stdin.on("end", cleanup);
    stdin.on("close", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === "\x03") return cleanup();
      const args =
        key === "s"
          ? ["install", "--force"]
          : key === "r"
            ? ["install"]
            : key === "u"
              ? ["uninstall"]
              : null;
      if (!args || done) return;
      render("working...");
      const result = capture(binary, ["service", ...args]);
      const detail = (result.err || result.out).trim().split("\n").pop() ?? "";
      render(
        result.code === 0 ? "done" : `failed (exit ${result.code}): ${detail}`,
      );
    });
    render();
  });
}

export async function runPluginCommand(
  args: string[],
  version: string,
  binary = process.execPath,
): Promise<number | null> {
  if (args[0] !== "plugin") return null;
  if (args.length === 2) {
    if (args[1] === "version") {
      console.log(`roamgate ${version}`);
      return 0;
    }
    if (args[1] === "url") return printUrl();
    if (args[1] === "panel") return panel(binary, version);
    const serviceArgs =
      args[1] === "start"
        ? ["install", "--force"]
        : args[1] === "restart"
          ? ["install"]
          : args[1] === "status"
            ? ["status"]
            : args[1] === "uninstall"
              ? ["uninstall"]
              : null;
    if (serviceArgs) {
      const result = spawnSync(binary, ["service", ...serviceArgs], {
        stdio: "inherit",
      });
      if (result.error)
        console.error(`roamgate plugin: ${result.error.message}`);
      return result.status ?? 1;
    }
  }
  console.error(
    "Usage: roamgate plugin <start|restart|status|url|version|uninstall|panel>",
  );
  return args.length === 1 || (args.length === 2 && args[1] === "--help")
    ? 0
    : 1;
}
