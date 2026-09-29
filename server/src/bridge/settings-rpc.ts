import {
  WorktreeHookConfigError,
  type createWorktreeHookRunner,
} from "../worktree/worktree-hooks";
import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import type { HerdrClient } from "./herdr-client";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import {
  connectionSettingsPrefix,
  DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
  type GuiRepoSettings,
  guiSettingsPath,
  readGuiSettings,
  repoWorktreeHooksEnabled,
  terminalSurfaceCodecsEnabled,
  updateGuiSettings,
  workspaceAutoSyncSettingsKey,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";
import {
  checkoutPath as workspaceCheckoutPath,
  sourceCheckoutPath as workspaceSourceCheckoutPath,
} from "../workspace/utils";

type ReadWorktreeHooks = ReturnType<
  typeof createWorktreeHookRunner
>["readWorktreeHooks"];

export function createSettingsRpcHandler(args: {
  connectionId?: string;
  connectionGeneration?: number;
  readSettings?: typeof readGuiSettings;
  updateSettings?: typeof updateGuiSettings;
  herdr: HerdrClient;
  sshHost: () => string | undefined;
  readWorktreeHooks: ReadWorktreeHooks;
  resolveWorkspaceGitRoot: (workspaceId: string) => Promise<{
    workspace: any;
    root: string;
  }>;
  workspaceAutoSyncIsRunning: (key: string) => boolean;
  onWorkspaceAutoSyncSettingsChanged: (key: string, enabled: boolean) => void;
  onTerminalTransportSettingsChanged?: (enabled: boolean) => void;
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
  ) => boolean;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
}) {
  const readSettings = args.readSettings ?? readGuiSettings;
  const updateSettings = args.updateSettings ?? updateGuiSettings;
  const serialize = (message: Record<string, unknown>) =>
    args.connectionId
      ? serializeConnectionEnvelope(
          args.connectionId,
          message,
          args.connectionGeneration,
        )
      : JSON.stringify(message);

  function repoSettingsKey(workspace: any): string | null {
    return workspaceRepoSettingsKey(
      workspace,
      args.sshHost(),
      args.connectionId,
    );
  }

  function ownsSettingsKey(key: string): boolean {
    const host = args.sshHost();
    const prefix = `${connectionSettingsPrefix(args.connectionId)}${host ? `ssh:${host}` : "local"}:`;
    return key.startsWith(prefix);
  }

  return async function handleSettingsRpc(
    ws: ServerWebSocket<unknown>,
    id: string,
    method: string,
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean = () => true,
  ) {
    const fail = (message: string) => {
      const effectiveMessage = requestIsCurrent()
        ? message
        : CONNECTION_CHANGED_DURING_REQUEST;
      args.markRpcError(ws, id, effectiveMessage);
      return args.safeSend(
        ws,
        serialize({ id, error: { message: effectiveMessage } }),
        `${method}-error`,
      );
    };
    const reply = (result: unknown) =>
      requestIsCurrent()
        ? args.safeSend(ws, serialize({ id, result }), method)
        : fail(CONNECTION_CHANGED_DURING_REQUEST);
    try {
      if (!requestIsCurrent()) return fail(CONNECTION_CHANGED_DURING_REQUEST);
      if (method === "settings.terminal_transport.get") {
        const settings = await readSettings();
        return reply({
          surface_codecs: terminalSurfaceCodecsEnabled(
            settings,
            args.connectionId,
          ),
        });
      }
      if (method === "settings.terminal_transport.update") {
        if (
          typeof params.surface_codecs !== "boolean" ||
          Object.keys(params).some((key) => key !== "surface_codecs")
        )
          return fail(
            "settings.terminal_transport.update requires only a boolean surface_codecs",
          );
        const enabled = params.surface_codecs;
        const connectionId = args.connectionId ?? LEGACY_DEFAULT_CONNECTION_ID;
        let changed = false;
        const settings = await updateSettings((current) => {
          changed =
            terminalSurfaceCodecsEnabled(current, connectionId) !== enabled;
          return {
            ...current,
            terminal_transport: {
              ...current.terminal_transport,
              [connectionId]: { surface_codecs: enabled },
            },
          };
        }, requestIsCurrent);
        if (changed) args.onTerminalTransportSettingsChanged?.(enabled);
        return reply({
          surface_codecs: terminalSurfaceCodecsEnabled(settings, connectionId),
        });
      }
      if (method === "settings.get") {
        const settings = await readSettings();
        return reply({ settings, path: guiSettingsPath() });
      }
      if (method === "settings.worktree_hooks.get") {
        const workspaceId = String(params.workspace_id ?? "");
        if (!workspaceId) {
          return fail("settings.worktree_hooks.get requires workspace_id");
        }
        const workspaceResult = await args.herdr.call("workspace.get", {
          workspace_id: workspaceId,
        });
        const workspace = workspaceResult?.workspace;
        if (!workspace?.worktree) {
          return reply({
            workspace_id: workspaceId,
            key: null,
            enabled: true,
            hooks: {},
            config_path: null,
            config_source: null,
            paseo_path: null,
            error: "workspace has no worktree metadata",
          });
        }
        const key = repoSettingsKey(workspace);
        const checkoutPath = workspaceCheckoutPath(workspace);
        const sourceCheckoutPath = workspaceSourceCheckoutPath(workspace);
        let loaded: Awaited<ReturnType<ReadWorktreeHooks>> = null;
        let readError: string | undefined;
        let configPath: string | null = null;
        let configSource: "roamgate" | "paseo" | null = null;
        try {
          loaded = await args.readWorktreeHooks(
            checkoutPath,
            sourceCheckoutPath,
          );
        } catch (e) {
          readError = (e as Error).message;
          if (e instanceof WorktreeHookConfigError) {
            configPath = e.path;
            configSource = e.source;
          }
        }
        configPath = loaded?.path ?? configPath;
        configSource = loaded?.source ?? configSource;
        return reply({
          workspace_id: workspaceId,
          key,
          enabled: await repoWorktreeHooksEnabled(key),
          repo_name: workspace.worktree.repo_name,
          repo_root: workspace.worktree.repo_root,
          checkout_path: checkoutPath,
          source_checkout_path: sourceCheckoutPath,
          config_path: configPath,
          config_source: configSource,
          paseo_path: configSource === "paseo" ? configPath : null,
          hooks: loaded?.config ?? {},
          error: readError,
        });
      }
      if (method === "settings.workspace_auto_sync.get") {
        const workspaceId = String(params.workspace_id ?? "");
        if (!workspaceId) {
          return fail("settings.workspace_auto_sync.get requires workspace_id");
        }
        const { workspace, root } =
          await args.resolveWorkspaceGitRoot(workspaceId);
        const key = workspaceAutoSyncSettingsKey(
          root,
          args.sshHost(),
          args.connectionId,
        );
        if (!key) {
          return fail("workspace has no checkout path");
        }
        const settings = await readSettings();
        const entry = settings.workspace_auto_sync[key];
        return reply({
          workspace_id: workspaceId,
          workspace_label: workspace?.label,
          checkout_path: root,
          key,
          enabled: entry?.enabled === true,
          interval_minutes:
            entry?.interval_minutes ??
            DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
          last_run_at: entry?.last_run_at,
          last_status: entry?.last_status,
          last_message: entry?.last_message,
          last_branch: entry?.last_branch,
          running: args.workspaceAutoSyncIsRunning(key),
        });
      }
      if (method === "settings.workspace_auto_sync.list") {
        const settings = await readSettings();
        return reply({
          configs: Object.entries(settings.workspace_auto_sync)
            .filter(([key]) => ownsSettingsKey(key))
            .map(([key, entry]) => ({
              key,
              ...entry,
              running: args.workspaceAutoSyncIsRunning(key),
            }))
            .sort((a, b) => a.key.localeCompare(b.key)),
          path: guiSettingsPath(),
        });
      }
      if (method === "settings.workspace_auto_sync.update_key") {
        const key = String(params.key ?? "");
        if (!key) {
          return fail("settings.workspace_auto_sync.update_key requires key");
        }
        if (typeof params.enabled !== "boolean") {
          return fail(
            "settings.workspace_auto_sync.update_key requires enabled",
          );
        }
        if (!ownsSettingsKey(key)) {
          return fail(
            "workspace auto-sync config belongs to another connection",
          );
        }
        const enabled = params.enabled;
        const updated = await updateSettings((current) => {
          const existing = current.workspace_auto_sync[key];
          if (!existing) {
            throw new Error(`unknown workspace auto-sync config: ${key}`);
          }
          const entry = { ...existing, enabled };
          return {
            ...current,
            workspace_auto_sync: {
              ...current.workspace_auto_sync,
              [key]: entry,
            },
          };
        }, requestIsCurrent);
        if (!requestIsCurrent()) {
          return fail(CONNECTION_CHANGED_DURING_REQUEST);
        }
        const entry = updated.workspace_auto_sync[key];
        args.onWorkspaceAutoSyncSettingsChanged(key, enabled);
        return reply({ key, ...entry });
      }
      if (method === "settings.workspace_auto_sync.update") {
        const workspaceId = String(params.workspace_id ?? "");
        if (!workspaceId) {
          return fail(
            "settings.workspace_auto_sync.update requires workspace_id",
          );
        }
        if (typeof params.enabled !== "boolean") {
          return fail("settings.workspace_auto_sync.update requires enabled");
        }
        const enabled = params.enabled;
        const { workspace, root } =
          await args.resolveWorkspaceGitRoot(workspaceId);
        const key = workspaceAutoSyncSettingsKey(
          root,
          args.sshHost(),
          args.connectionId,
        );
        if (!key) {
          return fail("workspace has no checkout path");
        }
        const updated = await updateSettings((current) => {
          const existing = current.workspace_auto_sync[key];
          const entry = {
            enabled,
            interval_minutes:
              existing?.interval_minutes ??
              DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
            checkout_path: root,
            host: args.sshHost(),
            last_run_at: existing?.last_run_at,
            last_status: existing?.last_status,
            last_message: existing?.last_message,
            last_branch: existing?.last_branch,
          };
          return {
            ...current,
            workspace_auto_sync: {
              ...current.workspace_auto_sync,
              [key]: entry,
            },
          };
        }, requestIsCurrent);
        if (!requestIsCurrent()) {
          return fail(CONNECTION_CHANGED_DURING_REQUEST);
        }
        const entry = updated.workspace_auto_sync[key];
        args.onWorkspaceAutoSyncSettingsChanged(key, enabled);
        return reply({
          workspace_id: workspaceId,
          workspace_label: workspace?.label,
          key,
          ...entry,
          running: args.workspaceAutoSyncIsRunning(key),
        });
      }
      if (method === "settings.update_repo") {
        const key = String(params.key ?? "");
        if (!key) return fail("settings.update_repo requires key");
        if (!ownsSettingsKey(key)) {
          return fail("repository settings belong to another connection");
        }
        const patch =
          params.settings && typeof params.settings === "object"
            ? (params.settings as Partial<GuiRepoSettings>)
            : {};
        const settings = await updateSettings((current) => {
          const existing = current.repositories[key] ?? {};
          const next: GuiRepoSettings = { ...existing };
          if (typeof patch.worktree_hooks_enabled === "boolean") {
            next.worktree_hooks_enabled = patch.worktree_hooks_enabled;
          }
          if (patch.custom && typeof patch.custom === "object") {
            next.custom = { ...(existing.custom ?? {}), ...patch.custom };
          }
          return {
            ...current,
            repositories: {
              ...current.repositories,
              [key]: next,
            },
          };
        }, requestIsCurrent);
        const next = settings.repositories[key];
        return reply({ settings, repo: next, key });
      }
      return fail(`unknown settings method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
