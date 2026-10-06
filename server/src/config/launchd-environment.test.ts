import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLaunchdEnvironment } from "./launchd-environment";

const tempDirs: string[] = [];
afterEach(() => {
  for (const path of tempDirs.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const fixtures: Array<{
  name: string;
  contents: string;
  expected: Record<string, string>;
}> = [
  {
    name: "exports, comments, and hashes within words",
    contents:
      "  # leading comment\n\texport A=first#part \t# trailing comment\nB= # empty\nC='# literal'\n",
    expected: { A: "first#part", B: "", C: "# literal" },
  },
  {
    name: "prior assignments, overrides, and both variable reference forms",
    contents:
      'A=initial\nA=updated\nB="$A ${A}suffix"\nC=$B\nD="$HOME/cert.pem"',
    expected: {
      A: "updated",
      B: "updated updatedsuffix",
      C: "updated updatedsuffix",
      D: "/test/home/cert.pem",
    },
  },
  {
    name: "single quotes, escaped dollars, and quote concatenation",
    contents:
      "A='$UNDEFINED and ${UNDEFINED}'\nB=\"\\$UNDEFINED and \\${UNDEFINED}\"\nC=unquoted\" double \"'single'\nD='can'\\''t'\n",
    expected: {
      A: "$UNDEFINED and ${UNDEFINED}",
      B: "$UNDEFINED and ${UNDEFINED}",
      C: "unquoted double single",
      D: "can't",
    },
  },
  {
    name: "double-quoted and unquoted escapes",
    contents: String.raw`A="backslash:\\ quote:\" tick:\` other:\q"
B=escaped\ space\#hash\;operator
`,
    expected: {
      A: 'backslash:\\ quote:" tick:` other:\\q',
      B: "escaped space#hash;operator",
    },
  },
  {
    name: "literal dollars followed by punctuation or end of input",
    contents: "A=\"$.:/ $% $= $'literal' $\"\nB=$.,:/%=\nC=$",
    expected: { A: "$.:/ $% $= $'literal' $", B: "$.,:/%=", C: "$" },
  },
  {
    name: "line continuations and quoted newlines",
    contents:
      'A=first\\\nsecond\nB="third\\\nfourth"\nC=\'fifth\nsixth\'\nD="seventh\neighth"\n',
    expected: {
      A: "firstsecond",
      B: "thirdfourth",
      C: "fifth\nsixth",
      D: "seventh\neighth",
    },
  },
  {
    name: "expanded metacharacters stay literal",
    contents: "A='$(touch marker); `whoami` $HOME * & < >'\nB=\"$A\"\nC=$B\n",
    expected: {
      A: "$(touch marker); `whoami` $HOME * & < >",
      B: "$(touch marker); `whoami` $HOME * & < >",
      C: "$(touch marker); `whoami` $HOME * & < >",
    },
  },
  {
    name: "ordinary variable names cannot mutate the object prototype",
    contents:
      'constructor=literal\n__proto__=safe\nA="${__proto__} $constructor"',
    expected: {
      constructor: "literal",
      ["__proto__"]: "safe",
      A: "safe literal",
    },
  },
];

describe("launchd environment resolution", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(
        resolveLaunchdEnvironment(
          fixture.contents,
          "/config.env",
          "/test/home",
        ),
      ).toEqual({ HOME: "/test/home", ...fixture.expected });
    });
    for (const [shellName, shell] of [
      ["sh", ["/bin/sh"]],
      ["Bash POSIX", ["/bin/bash", "--posix"]],
    ] as const) {
      test.skipIf(process.platform === "win32" || !existsSync(shell[0]))(
        `${fixture.name} matches ${shellName} sourcing`,
        () => {
          const directory = mkdtempSync(join(tmpdir(), "roamgate-env-"));
          tempDirs.push(directory);
          const path = join(directory, "config's $ file.env");
          writeFileSync(path, fixture.contents);
          const names = Object.keys(fixture.expected);
          const result = Bun.spawnSync(
            [
              ...shell,
              "-c",
              `set -a; . "$1"; printf '%s\\0' ${names.map((name) => `"$${name}"`).join(" ")}`,
              "roamgate-environment-test",
              path,
            ],
            { env: { HOME: "/test/home" } },
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr.toString()).toBe("");
          expect(result.stdout.toString().split("\0").slice(0, -1)).toEqual(
            Object.values(fixture.expected),
          );
        },
      );
    }
  }

  test.each([
    'A="$(touch marker)"',
    "A=`touch marker`",
    "A=$((1+1))",
    "A=$[1+1]",
    "A=safe; touch marker",
    "A=safe | cat",
    "A=safe > marker",
    "A=safe &",
    "A=<(cat marker)",
    "printf 'config output'",
    "source other.env",
    "A=one B=two",
    "export A",
    "A =value",
    "A= value",
    "A=~/file",
    "A=x:~/file",
    "A=${HOME:-fallback}",
    "A=$?",
    "A=$$",
    "A=$1",
    "A=$UNDEFINED",
    "A=${UNDEFINED}",
    "A=$A",
    'A="$\\\nHOME"',
    'A="$HOME\\\n_SUFFIX"',
    'A="$\\\n(touch marker)"',
    "A=$'ansi\\nquote'",
    'A=$"translated"',
    "A='unterminated",
    'A="unterminated',
    "A=unfinished\\",
    "UID=123",
    "RANDOM=123",
    "BASH_ENV=/file",
    "IFS=other",
    "A=value\0",
    "A='value\0'",
    "A=escaped\\\0",
    "# comment\0\nA=value",
  ])(
    "rejects unsupported input without exposing its contents (%#)",
    (contents) => {
      let error: unknown;
      try {
        resolveLaunchdEnvironment(contents, "/config.env", "/test/home");
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toStartWith(
        "invalid launchd environment at /config.env:1:",
      );
      expect((error as Error).message).not.toContain(contents);
    },
  );

  test.each([
    "OPTIND",
    "GROUPS",
    "HISTCMD",
    "DIRSTACK",
    "FUNCNAME",
    "PIPESTATUS",
    "EPOCHSECONDS",
    "EPOCHREALTIME",
  ])("rejects shell-managed variable %s", (name) => {
    expect(() =>
      resolveLaunchdEnvironment(
        `${name}=000000000000001\nROAMGATE_PASSWORD="$${name}"`,
        "/config.env",
        "/test/home",
      ),
    ).toThrow("shell-special variable assignments are not supported");
  });

  test.skipIf(process.platform === "win32" || !existsSync("/bin/bash"))(
    "Bash POSIX normalizes shell-managed values rather than using their configured strings",
    () => {
      for (const name of [
        "OPTIND",
        "GROUPS",
        "HISTCMD",
        "DIRSTACK",
        "FUNCNAME",
      ]) {
        const result = Bun.spawnSync(
          [
            "/bin/bash",
            "--posix",
            "-c",
            `${name}=000000000000001; OTHER=value; ROAMGATE_PASSWORD="$${name}"; printf '%s' "$ROAMGATE_PASSWORD"`,
          ],
          { env: { HOME: "/test/home" } },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).not.toBe("000000000000001");
      }
    },
  );

  test("does not borrow values from the installer's environment", () => {
    const previous = process.env.ROAMGATE_TEST_EXTERNAL_SECRET;
    process.env.ROAMGATE_TEST_EXTERNAL_SECRET = "synthetic-valid-password";
    try {
      expect(() =>
        resolveLaunchdEnvironment(
          'ROAMGATE_PASSWORD="$ROAMGATE_TEST_EXTERNAL_SECRET"',
          "/config.env",
          "/test/home",
        ),
      ).toThrow("define referenced variables earlier in the config");
    } finally {
      if (previous === undefined)
        delete process.env.ROAMGATE_TEST_EXTERNAL_SECRET;
      else process.env.ROAMGATE_TEST_EXTERNAL_SECRET = previous;
    }
  });
});
