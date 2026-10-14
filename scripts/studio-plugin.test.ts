import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "studio-plugin-source-test-"));
  roots.push(root);
  for (const dir of ["scripts", "server", "bin"]) mkdirSync(join(root, dir));
  copyFileSync(
    join(import.meta.dir, "studio-plugin.ts"),
    join(root, "scripts/studio-plugin.ts"),
  );
  writeFileSync(
    join(root, "bin/bun"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BUILD_LOG"
[ "\${FAIL_INSTALL:-}" != yes ] || exit 23
`,
    { mode: 0o755 },
  );
  return root;
}

function invoke(root: string, verb: string, env = {}) {
  return Bun.spawnSync(
    [process.execPath, join(root, "scripts/studio-plugin.ts"), verb],
    {
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        BUILD_LOG: join(root, "build.log"),
        ...env,
      },
    },
  );
}

test("source build uses the root frozen workspace lockfile", () => {
  const root = checkout();
  expect(invoke(root, "build-source").exitCode).toBe(0);
  expect(readFileSync(join(root, "build.log"), "utf8")).toBe(
    "install --frozen-lockfile\nrun build\n",
  );
});

test("source build stops after a dependency installation failure", () => {
  const root = checkout();
  expect(invoke(root, "build-source", { FAIL_INSTALL: "yes" }).exitCode).toBe(
    23,
  );
  expect(readFileSync(join(root, "build.log"), "utf8")).toBe(
    "install --frozen-lockfile\n",
  );
});

test.each([
  "start",
  "restart",
  "status",
  "url",
  "version",
  "uninstall",
  "panel",
])("legacy %s entry delegates to the native plugin command", (verb) => {
  const root = checkout();
  writeFileSync(
    join(root, "server/roamgate"),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$BUILD_LOG"\nexit 23\n',
    { mode: 0o755 },
  );
  expect(invoke(root, verb).exitCode).toBe(23);
  expect(readFileSync(join(root, "build.log"), "utf8")).toBe(
    `plugin ${verb}\n`,
  );
});

test("a missing source binary fails without silently downloading a release", () => {
  const root = checkout();
  const result = invoke(root, "start");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("build-source");
  expect(existsSync(join(root, "build.log"))).toBe(false);
});
