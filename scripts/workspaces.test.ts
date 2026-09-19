import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);

test("workspaces share one lockfile and root development tooling", () => {
  const requireRoot = createRequire(new URL("package.json", root));
  const manifest = requireRoot("./package.json");
  const lock = Bun.JSONC.parse(
    readFileSync(new URL("bun.lock", root), "utf8"),
  ) as { workspaces: Record<string, unknown> };
  expect(manifest.workspaces).toEqual(["web", "server"]);
  expect(Object.keys(lock.workspaces).sort()).toEqual(["", "server", "web"]);
  for (const workspace of manifest.workspaces) {
    const requireWorkspace = createRequire(
      new URL(`${workspace}/package.json`, root),
    );
    const child = requireWorkspace("./package.json");
    for (const lockfile of [
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ]) {
      expect(existsSync(new URL(`${workspace}/${lockfile}`, root))).toBe(false);
    }
    for (const tool of ["typescript", "bun-types"]) {
      expect(manifest.devDependencies[tool]).toBeDefined();
      expect(child.devDependencies?.[tool]).toBeUndefined();
      expect(child.dependencies?.[tool]).toBeUndefined();
      expect(requireWorkspace.resolve(`${tool}/package.json`)).toBe(
        requireRoot.resolve(`${tool}/package.json`),
      );
    }
  }
});

test("development bridge and Vite proxies stay off the production port", async () => {
  const requireRoot = createRequire(new URL("package.json", root));
  const { scripts } = requireRoot("./server/package.json");
  expect(scripts.dev).toBe(
    "HOST=127.0.0.1 PORT=8788 bun run --hot src/index.ts",
  );
  expect(scripts.start).toBe("bun run src/index.ts");

  const { default: config } = await import("../web/vite.config");
  for (const path of ["/api", "/ws", "/login"]) {
    expect(config.server?.proxy?.[path]).toMatchObject({
      target: "http://127.0.0.1:8788",
    });
  }
  expect(config.server?.proxy?.["/ws"]).toMatchObject({ ws: true });
});

test("CI and release jobs install once from the workspace root", () => {
  for (const file of ["ci.yml", "prepare-release.yml", "release.yml"]) {
    const workflow = Bun.YAML.parse(
      readFileSync(new URL(`.github/workflows/${file}`, root), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          steps: { run?: string; "working-directory"?: string }[];
        }
      >;
    };
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const installs = job.steps.filter((step) =>
        step.run?.includes("bun install"),
      );
      expect(installs).toEqual(
        name === "publish" ? [] : [{ run: "bun install --frozen-lockfile" }],
      );
    }
  }
});
