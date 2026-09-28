import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-gui-handler-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("workspace file handlers", () => {
  test("falls back to focused pane cwd when workspace has no checkout path", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "README.md"), "hello");
      const calls: string[] = [];
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            calls.push(method);
            if (method === "workspace.get") {
              return { workspace: { workspace_id: "w1", label: "Repo" } };
            }
            if (method === "pane.list") {
              return {
                panes: [
                  {
                    workspace_id: "w1",
                    focused: true,
                    foreground_cwd: root,
                  },
                ],
              };
            }
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: root,
          stderr: "",
        }),
        shQuote,
      });

      const list = await handlers.listWorkspaceFiles({ workspace_id: "w1" });
      expect(list).toMatchObject({
        workspace_id: "w1",
        repo_name: "Repo",
        checkout_path: root,
      });
      expect(list.entries.map((entry) => entry.name)).toEqual([
        "src",
        "README.md",
      ]);
      expect(calls).toEqual(["workspace.get", "pane.list"]);
    });
  });

  test("prefers pane cwd over an agent foreground directory for git operations", async () => {
    const calls: string[][] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get") {
            return { workspace: { workspace_id: "w1", label: "Repo" } };
          }
          if (method === "pane.list") {
            return {
              panes: [
                {
                  workspace_id: "w1",
                  focused: true,
                  cwd: "/repo",
                  foreground_cwd: "/agent/plugin",
                },
              ],
            };
          }
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "/repo\n", stderr: "" };
      },
      shQuote,
    });

    await expect(
      handlers.resolveWorkspaceGitRoot({ workspace_id: "w1" }),
    ).resolves.toMatchObject({ root: "/repo" });
    expect(calls).toEqual([
      ["git", "-C", "/repo", "rev-parse", "--show-toplevel"],
    ]);
  });

  test("returns download responses with safe headers", async () => {
    await withTempDir(async (root) => {
      await writeFile(join(root, "测试.txt"), "hello");
      await writeFile(join(root, "guide.pdf"), "%PDF-1.7");
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            if (method === "workspace.get") {
              return {
                workspace: {
                  workspace_id: "w1",
                  worktree: { checkout_path: root, repo_name: "Repo" },
                },
              };
            }
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: root,
          stderr: "",
        }),
        shQuote,
      });

      const response = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "测试.txt",
      });
      expect(response.headers.get("content-disposition")).toContain(
        'filename="__.txt"',
      );
      expect(response.headers.get("x-file-path")).toBe(
        encodeURIComponent("测试.txt"),
      );
      expect(await response.text()).toBe("hello");

      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      await writeFile(join(root, "vector.svg"), svg);
      const svgResponse = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "vector.svg",
        inline: true,
      });
      expect(svgResponse.headers.get("content-type")).toBe("image/svg+xml");
      expect(svgResponse.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
      expect(svgResponse.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await svgResponse.text()).toBe(svg);

      const inlineResponse = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "guide.pdf",
        inline: true,
      });
      expect(inlineResponse.headers.get("content-type")).toBe(
        "application/pdf",
      );
      expect(inlineResponse.headers.get("content-disposition")).toContain(
        "inline;",
      );
      expect(inlineResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(inlineResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(await inlineResponse.text()).toBe("%PDF-1.7");

      await writeFile(join(root, "take.wav"), "RIFF");
      const audioResponse = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "take.wav",
        inline: true,
      });
      expect(audioResponse.headers.get("content-type")).toBe("audio/wav");
      expect(audioResponse.headers.get("content-disposition")).toContain(
        "inline;",
      );
      expect(audioResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(await audioResponse.text()).toBe("RIFF");
    });
  });

  test("resolves existing workspace-relative files and directories in one batch", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "a", "b"), { recursive: true });
      await writeFile(join(root, "a", "b", "c.png"), "image");
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            if (method === "workspace.get") {
              return {
                workspace: {
                  workspace_id: "w1",
                  worktree: { checkout_path: root, repo_name: "Repo" },
                },
              };
            }
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
        }),
        shQuote,
      });

      expect(
        await handlers.resolveWorkspaceFiles({
          workspace_id: "w1",
          paths: [
            "a/b/c.png",
            "./a/b/c.png",
            "a/b",
            "missing/file.png",
            "../outside.txt",
          ],
        }),
      ).toMatchObject({
        workspace_id: "w1",
        checkout_path: root,
        files: [
          { candidate: "a/b/c.png", path: "a/b/c.png" },
          { candidate: "./a/b/c.png", path: "a/b/c.png" },
          { candidate: "a/b", path: "a/b" },
        ],
      });
    });
  });

  test("validates required workspace ids", async () => {
    const handlers = createFileHandlers({
      herdr: { call: async () => ({}) } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
      }),
      shQuote,
    });

    await expect(handlers.listWorkspaceFiles({})).rejects.toThrow(
      "file.list requires workspace_id",
    );
    await expect(
      handlers.readWorkspaceFile({ path: "README.md" }),
    ).rejects.toThrow("file.read requires workspace_id");
    await expect(handlers.resolveWorkspaceFiles({ paths: [] })).rejects.toThrow(
      "file.resolve requires workspace_id",
    );
  });
});
