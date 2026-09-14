import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HerdrClient } from "../bridge/herdr-client";
import { runProcessWithCode, shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";
import { sanitizeFilesystemPath } from "./file-paths";
import { listRemoteFiles } from "./remote-files";

async function fixture(
  run: (root: string, workspace: string, refs: string) => Promise<void>,
) {
  // Canonicalize: handlers resolve real paths (macOS /var -> /private/var).
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "herdr-filesystem-")),
  );
  try {
    const workspace = join(root, "workspace");
    const refs = join(root, "reference materials");
    await mkdir(workspace);
    await mkdir(refs);
    await writeFile(join(workspace, "workspace.md"), "workspace");
    await writeFile(join(refs, "readme.md"), "reference");
    await writeFile(join(refs, ".hidden.md"), "hidden");
    await symlink(refs, join(workspace, "external"), "dir");
    await run(root, workspace, refs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function handlers(workspace: string) {
  return createFileHandlers({
    herdr: {
      call: async (method: string) => {
        expect(method).toBe("workspace.get");
        return {
          workspace: { workspace_id: "w1", label: "Workspace", cwd: workspace },
        };
      },
    } as unknown as HerdrClient,
    sshHost: () => undefined,
    runProcessWithCodeTimeout: async () => {
      throw new Error("Unexpected remote call");
    },
    shQuote,
  });
}

test("filesystem paths must be explicit, absolute, and NUL-free", () => {
  expect(sanitizeFilesystemPath("/tmp/../refs")).toBe("/tmp/../refs");
  expect(sanitizeFilesystemPath("C:\\refs")).toBe("C:/refs");
  for (const path of [undefined, "", "refs", "../refs", "/refs\0"]) {
    expect(() => sanitizeFilesystemPath(path)).toThrow("absolute path");
  }
});

test("workspace listings stay confined; opt-in browsing can leave the checkout", async () => {
  await fixture(async (_root, workspace, refs) => {
    const files = handlers(workspace);
    const defaultList = await files.listWorkspaceFiles({ workspace_id: "w1" });
    expect(defaultList.root).toBe(workspace);
    expect(defaultList.entries.map((e) => e.path)).toEqual([
      "external",
      "workspace.md",
    ]);
    for (const params of [
      { path: "../reference materials" },
      { path: "external" },
      { path: refs, scope: "workspace" },
    ]) {
      await expect(
        files.listWorkspaceFiles({ workspace_id: "w1", ...params }),
      ).rejects.toThrow();
    }
    const list = await files.listWorkspaceFiles({
      workspace_id: "w1",
      scope: "filesystem",
      path: join(workspace, "..", "reference materials"),
    });
    expect(list).toMatchObject({
      root: refs,
      checkout_path: workspace,
      scope: "filesystem",
    });
    expect(list.entries.map((e) => e.path)).toEqual([join(refs, "readme.md")]);
    const hidden = await files.listWorkspaceFiles({
      workspace_id: "w1",
      scope: "filesystem",
      path: refs,
      show_hidden: true,
    });
    expect(hidden.entries).toHaveLength(2);
    const rootList = await files.listWorkspaceFiles({
      workspace_id: "w1",
      scope: "filesystem",
      path: workspace,
    });
    expect(rootList.entries.find((e) => e.name === "external")?.type).toBe(
      "directory",
    );
    const linked = await files.listWorkspaceFiles({
      workspace_id: "w1",
      scope: "filesystem",
      path: join(workspace, "external"),
    });
    expect(linked.root).toBe(refs);
    expect((await files.listWorkspaceFiles({ workspace_id: "w1" })).root).toBe(
      workspace,
    );
  });
});

test("external references preview and download without widening upload or delete targets", async () => {
  await fixture(async (_root, workspace, refs) => {
    const files = handlers(workspace);
    const path = join(refs, "readme.md");
    expect(
      await files.readWorkspaceFile({ workspace_id: "w1", path }),
    ).toMatchObject({ path, text: "reference" });
    const response = await files.downloadWorkspaceFile({
      workspace_id: "w1",
      path,
      scope: "filesystem",
    });
    expect(await response.text()).toBe("reference");
    await expect(
      files.downloadWorkspaceFile({ workspace_id: "w1", path }),
    ).rejects.toThrow();
    await expect(
      files.deleteWorkspaceFile({
        workspace_id: "w1",
        path,
        scope: "filesystem",
      }),
    ).rejects.toThrow();
    await expect(
      files.uploadWorkspaceFile(
        {
          workspace_id: "w1",
          directory: refs,
          filename: "readme.md",
          scope: "filesystem",
        },
        new Request("http://test", { method: "POST", body: "changed" }),
      ),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("reference");
  });
});

// Keep the two shell integrations on independent test deadlines.
test.each(["quoted external directories", "filesystem root"])(
  "SSH directory listings support %s",
  async (target) => {
    await fixture(async (_root, _workspace, refs) => {
      const path = target === "filesystem root" ? "/" : refs;
      const list = await listRemoteFiles({
        host: "fixture",
        rootPath: path,
        relativePath: "",
        showHidden: false,
        shQuote,
        // Execute only the generated command locally, as an SSH host fixture.
        runProcessWithCodeTimeout: (argv) =>
          runProcessWithCode(["bash", "-c", argv.at(-1)!]),
      });
      expect(list.root).toBe(path);
      if (path === refs)
        expect(list.entries.map((e) => e.name)).toEqual(["readme.md"]);
    });
  },
);
