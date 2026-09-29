import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { GuiSettings } from "../config/gui-settings";
import type { HerdrClient } from "./herdr-client";
import { WorktreeHookConfigError } from "../worktree/worktree-hooks";
import { createSettingsRpcHandler } from "./settings-rpc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("terminal transport settings validate input, persist by connection, and reconnect only on change", async () => {
  let settings: GuiSettings = {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: { keep: true },
    terminal_transport: { beta: { surface_codecs: false } },
  };
  const changed: boolean[] = [];
  const messages: any[] = [];
  let writes = 0;
  let failWrite = false;
  let cancelAfterWrite = false;
  let valid = true;
  const handler = createSettingsRpcHandler({
    connectionId: "alpha",
    connectionGeneration: 3,
    readSettings: async () => settings,
    updateSettings: async (update, isCurrent) => {
      expect(isCurrent?.()).toBe(true);
      if (failWrite) throw new Error("write failed");
      settings = await update(settings);
      writes++;
      if (cancelAfterWrite) valid = false;
      return settings;
    },
    onTerminalTransportSettingsChanged: (value) => {
      expect(settings.terminal_transport?.alpha.surface_codecs).toBe(value);
      changed.push(value);
    },
    herdr: {} as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async () => null,
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/tmp" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => {},
    safeSend: (_ws, payload) => {
      messages.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => {},
  });
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    current = true,
  ) =>
    handler(
      {} as ServerWebSocket<unknown>,
      "settings",
      `settings.terminal_transport.${method}`,
      params,
      () => current && valid,
    );
  await call("get");
  expect(messages.at(-1)).toMatchObject({
    connection_id: "alpha",
    connection_generation: 3,
    result: { surface_codecs: true },
  });
  for (const params of [
    {},
    { surface_codecs: "false" },
    { surface_codecs: false, connection_id: "beta" },
  ]) {
    await call("update", params);
    expect(messages.at(-1).error.message).toContain("boolean surface_codecs");
  }
  expect(writes).toBe(0);
  await call("update", { surface_codecs: false });
  await call("get");
  expect(messages.at(-1).result).toEqual({ surface_codecs: false });
  await call("update", { surface_codecs: false });
  expect(changed).toEqual([false]);
  await call("update", { surface_codecs: true });
  expect(changed).toEqual([false, true]);
  expect(settings.terminal_transport?.beta.surface_codecs).toBe(false);
  expect(settings.custom).toEqual({ keep: true });
  failWrite = true;
  await call("update", { surface_codecs: false });
  expect(messages.at(-1).error.message).toBe("write failed");
  expect(changed).toEqual([false, true]);
  const before = writes;
  await call("update", { surface_codecs: false }, false);
  expect(writes).toBe(before);
  expect(changed).toEqual([false, true]);
  failWrite = false;
  cancelAfterWrite = true;
  await call("update", { surface_codecs: false });
  expect(changed).toEqual([false, true, false]);
  expect(messages.at(-1).error).toBeDefined();
});

test("settings RPC errors carry their runtime connection identity", async () => {
  const messages: string[] = [];
  const handler = createSettingsRpcHandler({
    connectionId: "remote-dev",
    connectionGeneration: 6,
    herdr: {} as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async () => null,
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/tmp" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => undefined,
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    markRpcError: () => undefined,
  });

  await handler(
    {} as ServerWebSocket<unknown>,
    "settings-id",
    "settings.unknown",
    {},
  );

  expect(messages.map((message) => JSON.parse(message))).toEqual([
    {
      connection_id: "remote-dev",
      connection_generation: 6,
      id: "settings-id",
      error: { message: "unknown settings method: settings.unknown" },
    },
  ]);
});

test("settings RPC lists and mutates only its connection namespace", async () => {
  let settings: GuiSettings = {
    version: 1 as const,
    repositories: {
      "connection:alpha:local:same": { worktree_hooks_enabled: true },
      "connection:beta:local:same": { worktree_hooks_enabled: true },
    },
    workspace_auto_sync: {
      "connection:alpha:local:/same": {
        enabled: true,
        interval_minutes: 10,
        checkout_path: "/same",
      },
      "connection:beta:local:/same": {
        enabled: true,
        interval_minutes: 10,
        checkout_path: "/same",
      },
    },
    custom: {},
  };
  const messages: any[] = [];
  const handler = createSettingsRpcHandler({
    connectionId: "alpha",
    readSettings: async () => settings,
    updateSettings: async (update) => {
      settings = await update(settings);
      return settings;
    },
    herdr: {} as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async () => null,
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/same" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => undefined,
    safeSend: (_ws, payload) => {
      messages.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => undefined,
  });
  const ws = {} as ServerWebSocket<unknown>;

  await handler(ws, "list", "settings.workspace_auto_sync.list", {});
  await handler(ws, "cross-auto", "settings.workspace_auto_sync.update_key", {
    key: "connection:beta:local:/same",
    enabled: false,
  });
  await handler(ws, "cross-repo", "settings.update_repo", {
    key: "connection:beta:local:same",
    settings: { worktree_hooks_enabled: false },
  });
  await handler(ws, "own-auto", "settings.workspace_auto_sync.update_key", {
    key: "connection:alpha:local:/same",
    enabled: false,
  });

  expect(
    messages.find((message) => message.id === "list")?.result.configs,
  ).toHaveLength(1);
  expect(
    messages.find((message) => message.id === "list")?.result.configs[0].key,
  ).toBe("connection:alpha:local:/same");
  expect(
    messages.find((message) => message.id === "cross-auto")?.error.message,
  ).toContain("another connection");
  expect(
    messages.find((message) => message.id === "cross-repo")?.error.message,
  ).toContain("another connection");
  expect(
    settings.workspace_auto_sync["connection:alpha:local:/same"].enabled,
  ).toBe(false);
  expect(
    settings.workspace_auto_sync["connection:beta:local:/same"].enabled,
  ).toBe(true);
  expect(
    settings.repositories["connection:beta:local:same"].worktree_hooks_enabled,
  ).toBe(true);
});

test("settings RPC suppresses a delayed result after replacement", async () => {
  const workspace = deferred<any>();
  const messages: string[] = [];
  let current = true;
  const handler = createSettingsRpcHandler({
    connectionId: "remote-dev",
    herdr: {
      call: () => workspace.promise,
    } as unknown as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async () => null,
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/tmp" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => undefined,
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    markRpcError: () => undefined,
  });

  const pending = handler(
    {} as ServerWebSocket<unknown>,
    "settings-delayed",
    "settings.worktree_hooks.get",
    { workspace_id: "same" },
    () => current,
  );
  current = false;
  workspace.resolve({ workspace: {} });
  await pending;

  expect(messages.map((message) => JSON.parse(message))).toEqual([
    {
      connection_id: "remote-dev",
      id: "settings-delayed",
      error: { message: "connection changed during request" },
    },
  ]);
});

test("settings RPC cancels a queued mutation after replacement", async () => {
  const mutationGate = deferred<void>();
  let current = true;
  let notifications = 0;
  let settings: GuiSettings = {
    version: 1,
    repositories: {},
    workspace_auto_sync: {
      "connection:alpha:local:/same": {
        enabled: true,
        interval_minutes: 10,
        checkout_path: "/same",
      },
    },
    custom: {},
  };
  const messages: string[] = [];
  const handler = createSettingsRpcHandler({
    connectionId: "alpha",
    readSettings: async () => settings,
    updateSettings: async (update, shouldCommit = () => true) => {
      await mutationGate.promise;
      if (!shouldCommit()) throw new Error("settings update cancelled");
      settings = await update(settings);
      return settings;
    },
    herdr: {} as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async () => null,
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/same" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => {
      notifications += 1;
    },
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    markRpcError: () => undefined,
  });

  const pending = handler(
    {} as ServerWebSocket<unknown>,
    "stale-mutation",
    "settings.workspace_auto_sync.update_key",
    {
      key: "connection:alpha:local:/same",
      enabled: false,
    },
    () => current,
  );
  current = false;
  mutationGate.resolve(undefined);
  await pending;

  expect(
    settings.workspace_auto_sync["connection:alpha:local:/same"].enabled,
  ).toBe(true);
  expect(notifications).toBe(0);
  expect(JSON.parse(messages[0])).toMatchObject({
    connection_id: "alpha",
    id: "stale-mutation",
    error: { message: "connection changed during request" },
  });
});

test("hook settings expose selected config and errors without mislabeling native files as Paseo", async () => {
  let selected: "roamgate" | "paseo" | null = "roamgate";
  let invalid = false;
  const messages: any[] = [];
  const handler = createSettingsRpcHandler({
    herdr: {
      call: async () => ({
        workspace: {
          worktree: { checkout_path: "/target", repo_root: "/source" },
        },
      }),
    } as unknown as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async (target, source) => {
      expect([target, source]).toEqual(["/target", "/source"]);
      if (!selected) return null;
      const path = `/source/${selected}.json`;
      if (invalid)
        throw new WorktreeHookConfigError(
          path,
          selected,
          new Error("worktree.setup must be a string"),
        );
      return { path, source: selected, config: { setup: "true" } };
    },
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/source" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => {},
    safeSend: (_ws, payload) => {
      messages.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => {},
  });
  for (selected of ["roamgate", "paseo", null] as const) {
    for (invalid of [false, true]) {
      await handler(
        {} as ServerWebSocket<unknown>,
        "hooks",
        "settings.worktree_hooks.get",
        { workspace_id: "workspace" },
      );
      const result = messages.at(-1).result;
      expect(result).toMatchObject({
        config_path: selected ? `/source/${selected}.json` : null,
        config_source: selected,
        paseo_path: selected === "paseo" ? "/source/paseo.json" : null,
        hooks: selected && !invalid ? { setup: "true" } : {},
      });
      if (selected && invalid)
        expect(result.error).toContain(`/source/${selected}.json`);
      else expect(result.error).toBeUndefined();
    }
  }
});
