import { describe, expect, test } from "bun:test";
import { sshCommandArgv } from "../bridge/ssh-command";
import { gitShellCommandArgv } from "./git-shell";

const command = "git -C 'C:\\Users\\Jane Doe\\project' status --porcelain=v1";

function windowsOptions({
  git,
  sh,
  files = [],
  env = {},
}: {
  git?: string;
  sh?: string;
  files?: string[];
  env?: NodeJS.ProcessEnv;
} = {}) {
  return {
    platform: "win32" as const,
    env,
    which: (name: string) =>
      (name === "git" ? git : name === "sh" ? sh : undefined) ?? null,
    isFile: (path: string) => files.includes(path),
  };
}

describe("Windows Git shell discovery", () => {
  test("finds Git Bash when only Git's cmd directory is on PATH", () => {
    const shell = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(
      gitShellCommandArgv(
        command,
        undefined,
        windowsOptions({
          git: "C:\\Program Files\\Git\\cmd\\git.exe",
          files: [shell],
        }),
      ),
    ).toEqual([shell, "-lc", command]);
  });

  test.each([
    "bin",
    "mingw64\\bin",
    "mingw32\\bin",
    "ucrt64\\bin",
    "clangarm64\\bin",
  ])(
    "finds portable Git from %s without relying on standard locations",
    (directory) => {
      const shell = "D:\\Portable Git\\bin\\bash.exe";
      expect(
        gitShellCommandArgv(
          command,
          undefined,
          windowsOptions({
            git: `D:\\Portable Git\\${directory}\\git.exe`,
            files: [shell],
          }),
        )[0],
      ).toBe(shell);
    },
  );

  test("prefers the Git installation on PATH over a different default install", () => {
    const shell = "D:\\My Git\\bin\\bash.exe";
    expect(
      gitShellCommandArgv(
        command,
        undefined,
        windowsOptions({
          git: "D:\\My Git\\CMD\\git.exe",
          files: [shell, "C:\\Program Files\\Git\\bin\\bash.exe"],
        }),
      )[0],
    ).toBe(shell);
  });

  test("falls back to Git's usr/bin Bash when the wrapper is absent", () => {
    const shell = "D:\\Portable Git\\usr\\bin\\bash.exe";
    expect(
      gitShellCommandArgv(
        command,
        undefined,
        windowsOptions({
          git: "D:\\Portable Git\\cmd\\git.exe",
          files: [shell],
        }),
      )[0],
    ).toBe(shell);
  });

  test.each([
    [
      "ProgramFiles",
      "D:\\Program Files",
      "D:\\Program Files\\Git\\bin\\bash.exe",
    ],
    [
      "ProgramW6432",
      "D:\\Program Files",
      "D:\\Program Files\\Git\\bin\\bash.exe",
    ],
    [
      "ProgramFiles(x86)",
      "D:\\Program Files (x86)",
      "D:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ],
    [
      "localappdata",
      "D:\\Users\\Jane Doe\\AppData\\Local",
      "D:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    ],
  ])(
    "finds installations through %s without Git or sh on PATH",
    (key, value, shell) => {
      expect(
        gitShellCommandArgv(
          command,
          undefined,
          windowsOptions({ env: { [key]: value }, files: [shell] }),
        ),
      ).toEqual([shell, "-lc", command]);
    },
  );

  test("finds the default installation with an empty environment", () => {
    const shell = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(
      gitShellCommandArgv(
        command,
        undefined,
        windowsOptions({ files: [shell] }),
      ),
    ).toEqual([shell, "-lc", command]);
  });

  test("uses SystemDrive for default locations", () => {
    const shell = "E:\\Program Files\\Git\\bin\\bash.exe";
    expect(
      gitShellCommandArgv(
        command,
        undefined,
        windowsOptions({ env: { SystemDrive: "E:" }, files: [shell] }),
      )[0],
    ).toBe(shell);
  });

  test("keeps a POSIX sh on PATH as a fallback", () => {
    const shell = "C:\\Custom Shell\\sh.exe";
    expect(
      gitShellCommandArgv(command, undefined, windowsOptions({ sh: shell })),
    ).toEqual([shell, "-lc", command]);
  });

  test("preserves script quoting and passes an install path as one argv entry", () => {
    const shell = "D:\\Jane's tools & utilities\\Git\\bin\\bash.exe";
    const script =
      "git -C 'C:/Jane'\\''s project' show 'HEAD:file $(echo unsafe).txt' | base64";
    expect(
      gitShellCommandArgv(
        script,
        undefined,
        windowsOptions({
          git: "D:\\Jane's tools & utilities\\Git\\cmd\\git.exe",
          files: [shell],
        }),
      ),
    ).toEqual([shell, "-lc", script]);
  });

  test("explains how to recover when Git Bash and sh are missing", () => {
    const lookedUp: string[] = [];
    expect(() =>
      gitShellCommandArgv(command, undefined, {
        ...windowsOptions(),
        which: (name) => {
          lookedUp.push(name);
          return name === "bash" ? "C:\\Windows\\System32\\bash.exe" : null;
        },
      }),
    ).toThrow(
      "Install Git for Windows, or add its cmd or bin directory to PATH, then restart Roamgate",
    );
    // Do not mistake Windows' WSL bash launcher for a native Git Bash shell.
    expect(lookedUp).toEqual(["git", "sh"]);
  });

  test("does not probe relative environment paths from a workspace", () => {
    const checked: string[] = [];
    expect(() =>
      gitShellCommandArgv(command, undefined, {
        ...windowsOptions({ env: { ProgramFiles: "relative" } }),
        isFile: (path) => {
          checked.push(path);
          return false;
        },
      }),
    ).toThrow("Local Git operations require Git Bash");
    expect(checked.some((path) => path.startsWith("relative"))).toBe(false);
  });
});

describe("existing shell contracts", () => {
  test.each(["linux", "darwin"] as const)(
    "keeps %s shell execution unchanged",
    (platform) => {
      expect(
        gitShellCommandArgv(command, undefined, {
          platform,
          which: () => {
            throw new Error("unexpected local discovery");
          },
        }),
      ).toEqual(["sh", "-lc", command]);
    },
  );

  test("keeps remote execution unchanged even on a Windows host with no shell", () => {
    expect(
      gitShellCommandArgv(command, "user@dev.example", {
        platform: "win32",
        which: () => {
          throw new Error("unexpected local discovery");
        },
      }),
    ).toEqual(sshCommandArgv("user@dev.example", command));
  });
});
