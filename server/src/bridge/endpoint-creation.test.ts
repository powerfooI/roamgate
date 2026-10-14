import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkspacePath } from "../workspace/path";
import {
  assertEndpointCreationSource,
  createEmptyWorkspaceCreator,
  EndpointCreationDeadline,
  parseEndpointCreationSource,
} from "./endpoint-creation";
const source = {
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  terminal_id: "term1",
};
test("creation source validates all explicit identities and rejects moved or missing panes", () => {
  expect(parseEndpointCreationSource(source)).toEqual(source);
  for (const value of [
    null,
    [],
    {},
    { ...source, pane_id: 42 },
    { ...source, tab_id: "x".repeat(257) },
    { ...source, terminal_id: "\n" },
  ]) {
    expect(() => parseEndpointCreationSource(value)).toThrow();
  }
  expect(() =>
    assertEndpointCreationSource(source, { ...source, focused: false }),
  ).not.toThrow();
  for (const pane of [
    null,
    {},
    { ...source, workspace_id: "w2" },
    { ...source, tab_id: "w1:t2" },
    { ...source, terminal_id: "replacement" },
  ]) {
    expect(() => assertEndpointCreationSource(source, pane)).toThrow(
      "moved or closed",
    );
  }
});

for (const reason of ["lease", "deadline"] as const) {
  test(`empty bootstrap rechecks ${reason} after topology validation`, async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    const calls: string[] = [];
    const create = createEmptyWorkspaceCreator(async (method) => {
      calls.push(method);
      if (method === "workspace.list") await held;
      return { type: "workspace_list", workspaces: [] };
    });
    const deadline = new EndpointCreationDeadline(
      reason === "deadline" ? 10 : 20000,
    );
    const task = create({ browser_source: null }, () => current, deadline);
    const rejected = task.then(
      () => null,
      (error: Error) => error,
    );
    await Promise.resolve();
    if (reason === "deadline")
      await expect(deadline.wait(task)).rejects.toThrow(
        "expired before dispatch",
      );
    else current = false;
    release();
    expect(await rejected).toBeInstanceOf(Error);
    expect(calls).toEqual(["workspace.list"]);
  });
}

test("empty bootstrap rejects malformed and nonempty topology without mutation", async () => {
  for (const topology of [
    null,
    {},
    [],
    { type: "workspace_list", workspaces: null },
    { type: "wrong", workspaces: [] },
    { type: "workspace_list", workspaces: [{}] },
  ]) {
    const calls: string[] = [];
    const create = createEmptyWorkspaceCreator(async (method) => {
      calls.push(method);
      return topology;
    });
    await expect(
      create(
        { browser_source: null },
        () => true,
        new EndpointCreationDeadline(),
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(["workspace.list"]);
  }
});

test("empty bootstrap rechecks the directory after waiting for topology", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bootstrap-path-")));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const calls: string[] = [];
  const create = createEmptyWorkspaceCreator(async (method) => {
    calls.push(method);
    if (method === "workspace.list") {
      entered.resolve();
      await held.promise;
    }
    return { type: "workspace_list", workspaces: [] };
  });
  try {
    expect((await inspectWorkspacePath(cwd, {}, false)).error).toBeNull();
    const checkDirectory = async () => {
      const info = await inspectWorkspacePath(cwd, {}, false);
      if (info.error) throw new Error(info.error);
    };
    const pending = create(
      { cwd, browser_source: null },
      () => true,
      new EndpointCreationDeadline(),
      checkDirectory,
    ).then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    rmSync(cwd, { recursive: true });
    held.resolve();
    expect((await pending)?.message).toContain("Directory does not exist.");
    expect(calls).toEqual(["workspace.list"]);
    mkdirSync(cwd);
    await create(
      { cwd, browser_source: null },
      () => true,
      new EndpointCreationDeadline(),
      checkDirectory,
    );
    expect(calls).toEqual([
      "workspace.list",
      "workspace.list",
      "workspace.create",
    ]);
  } finally {
    held.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});
