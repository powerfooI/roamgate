import { expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import * as processUtils from "../utils/process-utils";
import { inspectWorkspacePath } from "./path";

for (const remote of [false, true]) {
  test(`${remote ? "SSH" : "local"} paths expand home, validate directories and complete prefixes safely`, async () => {
    if (remote && process.platform === "win32") return;
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "workspace-path-")),
    );
    const run = processUtils.runProcessWithCodeTimeout;
    const ssh = remote
      ? spyOn(processUtils, "runProcessWithCodeTimeout").mockImplementation(
          (argv, timeout) => {
            expect(argv[0]).toBe("ssh");
            expect(argv.at(-2)).toBe("remote-host");
            return run(["bash", "-c", argv.at(-1)!], timeout, { cwd: root });
          },
        )
      : null;
    const connection = remote ? { host: "remote-host" } : {};
    try {
      await mkdir(join(root, "project"));
      await mkdir(join(root, "project", "child"));
      await mkdir(join(root, "ProjectCase"));
      await mkdir(join(root, ".hidden"));
      if (process.platform !== "win32") {
        await mkdir(join(root, "literal\\"));
        await mkdir(join(root, "literal"));
        await mkdir(join(root, "literal\\", "child"));
        await mkdir(join(root, "literal", "other"));
        expect(
          (
            await inspectWorkspacePath(
              join(root, "literal\\"),
              connection,
              false,
            )
          ).path,
        ).toBe(join(root, "literal\\"));
        expect(
          (await inspectWorkspacePath(join(root, "literal\\"), connection))
            .directories,
        ).toEqual([join(root, "literal\\", "child")]);
        expect(
          (
            await inspectWorkspacePath(
              join(root, "literal\\", "ch"),
              connection,
            )
          ).directories,
        ).toEqual([join(root, "literal\\", "child")]);
      }
      const quoted = "quote' $(touch SENTINEL)";
      await mkdir(join(root, quoted));
      await writeFile(join(root, "file"), "text");
      await symlink(join(root, "project"), join(root, "linked"), "dir");

      expect(await inspectWorkspacePath("~", connection, false)).toMatchObject({
        path: await realpath(homedir()),
        error: null,
        directories: [],
      });
      if (process.platform === "win32") {
        const driveRoot = parse(root).root;
        for (const path of [driveRoot, `${driveRoot}/`]) {
          expect(await inspectWorkspacePath(path, connection, false)).toEqual({
            path: driveRoot,
            error: null,
            directories: [],
          });
        }
      }
      expect(
        await inspectWorkspacePath(
          `~/${relative(homedir(), root)}/project`,
          connection,
        ),
      ).toEqual({
        path: join(root, "project"),
        error: null,
        directories: [join(root, "project", "child")],
      });
      const list = await inspectWorkspacePath(`${root}/`, connection);
      expect(list.error).toBeNull();
      expect(list.directories).toContain(join(root, "project"));
      expect(list.directories).toContain(join(root, "linked"));
      expect(list.directories).not.toContain(join(root, ".hidden"));
      expect(list.directories).not.toContain(join(root, "file"));
      expect(
        (await inspectWorkspacePath(join(root, "projectc"), connection))
          .directories,
      ).toEqual(
        process.platform === "win32" ? [join(root, "ProjectCase")] : [],
      );
      expect(await inspectWorkspacePath(join(root, "pro"), connection)).toEqual(
        {
          path: join(root, "pro"),
          error: "Directory does not exist.",
          directories:
            process.platform === "win32"
              ? [join(root, "project"), join(root, "ProjectCase")]
              : [join(root, "project")],
        },
      );
      expect(
        (await inspectWorkspacePath(join(root, ".hid"), connection))
          .directories,
      ).toEqual([join(root, ".hidden")]);
      expect(
        (await inspectWorkspacePath(join(root, "file"), connection)).error,
      ).toBe("Path is not a directory.");
      expect(
        (await inspectWorkspacePath(join(root, "absent", "child"), connection))
          .error,
      ).toBe("Directory does not exist.");
      expect(
        (await inspectWorkspacePath(join(root, quoted), connection)).error,
      ).toBeNull();
      expect(
        (await inspectWorkspacePath(join(root, "SENTINEL"), connection)).error,
      ).toBe("Directory does not exist.");
      expect(
        (await inspectWorkspacePath(join(root, "linked"), connection, false))
          .path,
      ).toBe(join(root, "project"));
    } finally {
      ssh?.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("local completion filters the entire directory before limiting suggestions", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "workspace-path-limit-")),
  );
  try {
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        mkdir(join(root, `a-${i.toString().padStart(4, "0")}`)),
      ),
    );
    const matches = Array.from({ length: 53 }, (_, i) =>
      join(root, `z-project-${i.toString().padStart(3, "0")}`),
    );
    await Promise.all(matches.map((directory) => mkdir(directory)));
    const info = await inspectWorkspacePath(join(root, "z-project-"), {});
    expect(info.error).toBe("Directory does not exist.");
    expect(info.directories).toEqual(matches.slice(0, 50));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid paths fail before any host command", async () => {
  const command = spyOn(processUtils, "runProcessWithCodeTimeout");
  try {
    for (const path of [
      null,
      {},
      "",
      "relative",
      "~someone/project",
      "/tmp/\0",
      "/tmp/\n",
      "x".repeat(4097),
    ]) {
      await expect(
        inspectWorkspacePath(path, { host: "remote-host" }),
      ).rejects.toThrow();
    }
    expect(command).not.toHaveBeenCalled();
  } finally {
    command.mockRestore();
  }
});

test("Windows SSH paths use quoted PowerShell and the remote user's home", async () => {
  const command = spyOn(
    processUtils,
    "runProcessWithCodeTimeout",
  ).mockImplementation(async (argv) => {
    const wire = argv.at(-1)!;
    expect(wire).toStartWith("powershell.exe ");
    const script = Buffer.from(wire.split(" ").at(-1)!, "base64").toString(
      "utf16le",
    );
    expect(script).toContain("$env:USERPROFILE");
    expect(script).toContain("$path = '~/quote'' $(throw)' ".trimEnd());
    expect(script).toContain("-LiteralPath");
    return {
      code: 0,
      stdout: `PATH\t${Buffer.from("C:\\Users\\remote\\quote' $(throw)").toString("base64")}\nERROR\t\n`,
      stderr: "",
    };
  });
  try {
    expect(
      await inspectWorkspacePath(
        "~/quote' $(throw)",
        { host: "remote-host", remotePlatform: "windows" },
        false,
      ),
    ).toEqual({
      path: "C:\\Users\\remote\\quote' $(throw)",
      error: null,
      directories: [],
    });
  } finally {
    command.mockRestore();
  }
});
