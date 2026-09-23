import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const directory = mkdtempSync(join(tmpdir(), "roamgate-lint-"));
copyFileSync(
  new URL(".oxlintrc.json", root),
  join(directory, ".oxlintrc.json"),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function lint(source: string, path = "web/src/Fixture.tsx") {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(new URL("node_modules/oxlint/bin/oxlint", root)),
        "--format",
        "json",
        "--no-error-on-unmatched-pattern",
        path,
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const output = JSON.parse(result.stdout.toString()) as {
      diagnostics: { code?: string; severity: string }[];
    };
    expect(result.exitCode).toBe(
      output.diagnostics.some((item) => item.severity === "error") ? 1 : 0,
    );
    return output.diagnostics
      .map((item) => `${item.severity}:${item.code ?? "diagnostic"}`)
      .sort();
  } finally {
    rmSync(file);
  }
}

const missingDeps = `import { useEffect } from "react";
export function Component({value}) {
  useEffect(() => { console.log(value); },
  []);
  return null;
}`;

test("lint rejects conditional, repeated, nested and non-component Hooks", () => {
  for (const body of [
    "if (ok) useState(0);",
    "if (ok) return null; useState(0);",
    "while (ok) { useState(0); }",
    "[ok].map(() => useState(0));",
  ]) {
    expect(
      lint(`import { useState } from "react";
export function Component({ok}) { ${body} return null; }`),
    ).toEqual(["error:react-hooks(rules-of-hooks)"]);
  }
  expect(
    lint(`import { useState } from "react";
export function ordinary() { return useState(0); }`),
  ).toEqual(["error:react-hooks(rules-of-hooks)"]);
  expect(
    lint(`import { useEffect, useState } from "react";
export function Component({value}) {
  const [state, setState] = useState(0);
  useEffect(() => { setState(value); }, [value]);
  return state;
}`),
  ).toEqual([]);
});

test("dependency warnings retain scope and existing ESLint suppressions", () => {
  expect(lint(missingDeps)).toEqual(["warning:react-hooks(exhaustive-deps)"]);
  expect(lint(missingDeps, "web/vite.config.ts")).toEqual([
    "warning:react-hooks(exhaustive-deps)",
  ]);
  expect(lint(missingDeps, "scripts/fixture.ts")).toEqual([]);
  expect(
    lint(
      missingDeps.replace(
        "  []);",
        "// eslint-disable-next-line react-hooks/exhaustive-deps\n  []);",
      ),
    ),
  ).toEqual([]);
  expect(
    lint(
      "// eslint-disable-next-line react-hooks/exhaustive-deps\nexport const value = 1;",
    ),
  ).toEqual(["warning:diagnostic"]);
});

test("lint preserves recommended TypeScript rules and ESLint option defaults", () => {
  for (const [source, rule] of [
    ["const _unused = 1;", "eslint(no-unused-vars)"],
    ["export function f(_argument: string) {}", "eslint(no-unused-vars)"],
    [
      "const value = 1; export type Value = typeof value;",
      "eslint(no-unused-vars)",
    ],
    ["try { throw Error(); } catch (_error) {}", "eslint(no-unused-vars)"],
    ["export function f(value: boolean) { if(value) {} }", "eslint(no-empty)"],
    [
      "export function f() { for(;true;) { f(); } }",
      "eslint(no-constant-condition)",
    ],
    [
      "export function f(globalThis: string) { return globalThis; }",
      "eslint(no-shadow-restricted-names)",
    ],
    [
      "export namespace Foo { export const bar = 1; }",
      "typescript(no-namespace)",
    ],
    ["// @ts-ignore\nexport const value = 1;", "typescript(ban-ts-comment)"],
    [
      "export function f() { let x = 1; x = 2; return x; }",
      "eslint(no-useless-assignment)",
    ],
  ]) {
    expect(lint(source)).toEqual([`error:${rule}`]);
  }
  expect(
    lint(`try { throw Error(); } catch {}
export function f() { while(true) { f(); } }
export const value = 1 < 2;
export type Anything = any;
export type Empty = {};`),
  ).toEqual([]);
});

test("JavaScript globals and duplicate parameters remain checked", () => {
  expect(
    lint(
      'window.addEventListener("load", () => { document.title = "x"; });',
      "site/fixture.js",
    ),
  ).toEqual([]);
  expect(lint("missing();", "site/fixture.js")).toEqual([
    "error:eslint(no-undef)",
  ]);
  expect(lint("window = {};", "site/fixture.js")).toEqual([
    "error:eslint(no-global-assign)",
  ]);
  expect(lint("Bun = {};", "server/src/fixture.ts")).toEqual([
    "error:eslint(no-global-assign)",
  ]);
  expect(
    lint(
      'self.addEventListener("push", () => new URL("https://example.com"));',
      "web/public/task-notifications-sw.js",
    ),
  ).toEqual([]);
  expect(
    lint("function f(a, a) { return a; } f(1,2);", "site/fixture.js"),
  ).toEqual(["error:eslint(no-redeclare)"]);
});

test("generated assets, binaries and workspace dependencies stay ignored", () => {
  for (const path of [
    ".pages-dist/fixture.js",
    "dist/fixture.js",
    "node_modules/fixture.js",
    "server/herdr-gui-fixture.js",
    "server/roamgate-fixture.js",
    "server/public/fixture.js",
    "server/src/public-files.gen.ts",
    "web/dist/fixture.js",
    "web/node_modules/fixture.js",
    "server/node_modules/fixture.js",
  ]) {
    expect(lint("debugger;", path)).toEqual([]);
  }
});
