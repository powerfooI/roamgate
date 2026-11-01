import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateWorktreeBranchName,
  worktreeCommandProbeScript,
  worktreeCommandProgram,
  worktreeCommandScript,
  worktreeCommandTemplateError,
  worktreeShellArgv,
} from "./command-template";

describe("worktree command templates", () => {
  test("refuses placeholders inside quotes, allows them bare", () => {
    for (const template of [
      `mk "{path}"`,
      `mk '{branch}'`,
      `mk "x{base}y"`,
      `sh -c 'mk {repo}'`,
      `mk "$(echo {path})"`,
    ])
      expect(worktreeCommandTemplateError(template)).toContain(
        "Remove the quotes around",
      );
    for (const template of [
      "git recworktree add {path} --branch {branch} --base {base}",
      `mk {path} "literal 'text'" '{not a placeholder}' \\"{path}`,
      "rm {path} {force}",
    ])
      expect(worktreeCommandTemplateError(template)).toBeUndefined();
    expect(worktreeCommandTemplateError(`mk {path} "open`)).toContain(
      "unterminated",
    );
  });

  test("passes hostile values as data to a real sh", () => {
    const root = mkdtempSync(join(tmpdir(), "roamgate-worktree-sh-"));
    try {
      const marker = join(root, "pwned");
      const hostile = `a$(touch\${IFS}${marker})\`touch \${IFS}${marker}\`'"; touch ${marker}`;
      const script = worktreeCommandScript(
        "printf '%s|%s|%s|%s' {branch} {base} {repo} {path}",
        { branch: hostile, base: hostile, repo: hostile, path: hostile },
      );
      const run = Bun.spawnSync([
        "sh",
        "-c",
        `${script.exports}; ${script.command}`,
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(
        [hostile, hostile, hostile, hostile].join("|"),
      );
      expect(existsSync(marker)).toBe(false);
      // A quoted placeholder is refused before anything runs.
      expect(() =>
        worktreeCommandScript(`printf '%s' "{branch}"`, { branch: hostile }),
      ).toThrow("Remove the quotes around {branch}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expands a ~/ path on the host and {force} to --force or nothing", () => {
    const script = worktreeCommandScript("rm {path} {force}", {
      path: "~/w t",
      force: true,
    });
    const run = Bun.spawnSync(
      ["sh", "-c", `${script.exports}; printf %s "$ROAMGATE_WORKTREE_PATH"`],
      { env: { ...process.env, HOME: "/home/x" } },
    );
    expect(run.stdout.toString()).toBe("/home/x/w t");
    expect(script.command).toBe(`rm "$ROAMGATE_WORKTREE_PATH" --force`);
    expect(() => worktreeCommandScript("rm {branch}", { path: "/p" })).toThrow(
      "{branch} is not available",
    );
  });

  test("runs under sh -c over ssh, whatever the login shell", () => {
    const argv = worktreeShellArgv("host", `printf '%s' "$X"`);
    expect(argv[0]).toBe("ssh");
    expect(argv.at(-1)).toBe(`sh -c 'printf '\\''%s'\\'' "$X"'`);
    expect(worktreeShellArgv(undefined, "true")).toEqual(["sh", "-lc", "true"]);
  });
});

describe("worktree branch names", () => {
  test("accepts ordinary branch names", () => {
    for (const branch of ["feature/x", "fix-123", "user/topic.v2", "a_b+c"])
      expect(validateWorktreeBranchName(branch)).toBe(branch);
  });

  test("refuses git-invalid names and shell syntax", () => {
    for (const branch of [
      "",
      "a$(touch${IFS}/tmp/x)",
      "a`id`",
      "a;b",
      "a b",
      "a|b",
      "it's",
      '"q"',
      "-x",
      "a..b",
      "a//b",
      "/a",
      "a/",
      "a.",
      ".a",
      "a/.b",
      "a.lock",
      "a@{1}",
      "@",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "a\nb",
    ])
      expect(() => validateWorktreeBranchName(branch)).toThrow(
        "Invalid branch name",
      );
  });
});

describe("worktree command install probe", () => {
  test("names the program and git subcommand a template starts with", () => {
    expect(worktreeCommandProgram("git recworktree add {path}")).toEqual({
      program: "git",
      subcommand: "recworktree",
    });
    expect(worktreeCommandProgram("git -C x worktree add")).toEqual({
      program: "git",
    });
    expect(worktreeCommandProgram("  mk-tree {path}")).toEqual({
      program: "mk-tree",
    });
    expect(worktreeCommandProgram("FOO=1 mk {path}")).toBeUndefined();
    expect(worktreeCommandProgram("(cd x && mk)")).toBeUndefined();
  });

  test("exits 127 only for a missing program or git subcommand, with a real sh", () => {
    const probe = (template: string) =>
      Bun.spawnSync(["sh", "-c", worktreeCommandProbeScript(template)!])
        .exitCode;
    expect(probe("sh -c true")).toBe(0);
    expect(probe("git worktree add {path}")).toBe(0);
    expect(probe("roamgate-no-such-tool {path}")).toBe(127);
    expect(probe("git roamgate-no-such-subcommand {path}")).toBe(127);
  });
});

test("an escaped placeholder is refused before its inserted quote can be escaped", () => {
  expect(() => worktreeCommandScript("mk \\{path}", { path: "/a b" })).toThrow(
    "escape",
  );
});
