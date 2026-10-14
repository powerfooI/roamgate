#!/usr/bin/env bun
// Source-build helper and compatibility entry point; installed plugins run
// `roamgate plugin` directly and do not require an external Bun runtime.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(argv: string[]): number {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error) console.error(`studio-plugin: ${result.error.message}`);
  return result.status ?? 1;
}

function build(): number {
  return process.platform === "win32"
    ? run([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/install-plugin.ps1",
      ])
    : run(["sh", "scripts/install-plugin.sh"]);
}

function main(): number {
  const verb = process.argv[2];
  if (verb === "build-source") {
    const installed = run(["bun", "install", "--frozen-lockfile"]);
    return installed === 0 ? run(["bun", "run", "build"]) : installed;
  }
  if (verb === "build") return build();
  if (
    [
      "start",
      "restart",
      "status",
      "url",
      "version",
      "uninstall",
      "panel",
    ].includes(verb)
  ) {
    const binary = join(
      REPO_ROOT,
      "server",
      process.platform === "win32" ? "roamgate.exe" : "roamgate",
    );
    if (!existsSync(binary)) {
      console.error(
        "studio-plugin: binary missing; run build or build-source first",
      );
      return 1;
    }
    return run([binary, "plugin", verb]);
  }
  console.error(
    "Usage: bun scripts/studio-plugin.ts <build|build-source|start|restart|status|url|version|uninstall|panel>",
  );
  return verb ? 1 : 0;
}

if (import.meta.main) process.exit(main());
