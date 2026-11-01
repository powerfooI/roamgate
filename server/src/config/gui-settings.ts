import { normalizeTitleSuffix } from "../../../shared/instanceName";
import { defaultDataFile } from "./data-paths";
import { roamgateEnv } from "./environment";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import { serverLogger } from "../utils/logger";
import { sourceCheckoutPath as workspaceSourceCheckoutPath } from "../workspace/utils";

export type GuiRepoSettings = {
  worktree_hooks_enabled?: boolean;
  custom?: Record<string, unknown>;
};

export type WorkspaceAutoSyncStatus =
  | "updated"
  | "up_to_date"
  | "skipped"
  | "failed";

export type GuiWorkspaceAutoSyncSettings = {
  enabled: boolean;
  interval_minutes: number;
  checkout_path?: string;
  host?: string;
  last_run_at?: string;
  last_status?: WorkspaceAutoSyncStatus;
  last_message?: string;
  last_branch?: string;
};

export type GuiSettings = {
  version: 1;
  title_suffix?: string;
  auto_rename_agent_tabs?: boolean;
  repositories: Record<string, GuiRepoSettings>;
  workspace_auto_sync: Record<string, GuiWorkspaceAutoSyncSettings>;
  terminal_transport?: Record<string, { surface_codecs: boolean }>;
  custom: Record<string, unknown>;
  /**
   * Browser-agnostic interface preferences, namespaced by key (for example
   * `keyboardShortcuts`). The server never interprets a value: the frontend
   * owns each schema and validates on read, so a preference can change shape
   * without a server release. Kept here rather than in `localStorage` so one
   * user carries the same interface across every browser they open.
   */
  ui: Record<string, unknown>;
};

/** Namespaces are addressed by RPC, so keep them to unmistakable identifiers. */
const UI_SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A preference is configuration, not storage; refuse anything of size. */
export const UI_SETTING_MAX_BYTES = 64 * 1024;

export function uiSettingKeyIsValid(key: unknown): key is string {
  return typeof key === "string" && UI_SETTING_KEY_RE.test(key);
}

/** Rejects values that cannot round-trip through settings.json, or are huge. */
export function uiSettingValueError(value: unknown): string | null {
  if (value === undefined) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "";
  } catch {
    return "Preference value must be JSON-serializable.";
  }
  if (!encoded) return "Preference value must be JSON-serializable.";
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > UI_SETTING_MAX_BYTES) {
    return `Preference value is ${bytes} bytes; the limit is ${UI_SETTING_MAX_BYTES}.`;
  }
  return null;
}

export const DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES = 10;

let cachedGuiSettings: GuiSettings | null = null;
let settingsMutationQueue: Promise<void> = Promise.resolve();
let temporaryFileSequence = 0;

export function guiSettingsPath(): string {
  return roamgateEnv("SETTINGS_PATH") ?? defaultDataFile("settings.json");
}

function defaultGuiSettings(): GuiSettings {
  return {
    version: 1,
    title_suffix: "",
    auto_rename_agent_tabs: true,
    repositories: {},
    workspace_auto_sync: {},
    terminal_transport: {},
    custom: {},
    ui: {},
  };
}

function storedTitleSuffix(value: unknown): string {
  try {
    return normalizeTitleSuffix(value ?? "");
  } catch {
    return "";
  }
}

function normalizeGuiSettings(raw: unknown): GuiSettings {
  const obj = raw && typeof raw === "object" ? (raw as any) : {};
  const repositories =
    obj.repositories && typeof obj.repositories === "object"
      ? obj.repositories
      : {};
  const normalizedRepos: Record<string, GuiRepoSettings> = {};
  for (const [key, value] of Object.entries(repositories)) {
    if (!value || typeof value !== "object") continue;
    const repo = value as any;
    normalizedRepos[key] = {
      worktree_hooks_enabled:
        typeof repo.worktree_hooks_enabled === "boolean"
          ? repo.worktree_hooks_enabled
          : undefined,
      custom:
        repo.custom && typeof repo.custom === "object"
          ? (repo.custom as Record<string, unknown>)
          : undefined,
    };
  }
  const workspaceAutoSync =
    obj.workspace_auto_sync && typeof obj.workspace_auto_sync === "object"
      ? obj.workspace_auto_sync
      : {};
  const normalizedWorkspaceAutoSync: Record<
    string,
    GuiWorkspaceAutoSyncSettings
  > = {};
  for (const [key, value] of Object.entries(workspaceAutoSync)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as any;
    const lastStatus = ["updated", "up_to_date", "skipped", "failed"].includes(
      entry.last_status,
    )
      ? (entry.last_status as WorkspaceAutoSyncStatus)
      : undefined;
    normalizedWorkspaceAutoSync[key] = {
      enabled: entry.enabled === true,
      interval_minutes:
        typeof entry.interval_minutes === "number" &&
        Number.isFinite(entry.interval_minutes) &&
        entry.interval_minutes >= 1
          ? Math.round(entry.interval_minutes)
          : DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
      checkout_path:
        typeof entry.checkout_path === "string"
          ? entry.checkout_path
          : undefined,
      host: typeof entry.host === "string" ? entry.host : undefined,
      last_run_at:
        typeof entry.last_run_at === "string" ? entry.last_run_at : undefined,
      last_status: lastStatus,
      last_message:
        typeof entry.last_message === "string" ? entry.last_message : undefined,
      last_branch:
        typeof entry.last_branch === "string" ? entry.last_branch : undefined,
    };
  }
  return {
    version: 1,
    title_suffix: storedTitleSuffix(obj.title_suffix),
    auto_rename_agent_tabs:
      typeof obj.auto_rename_agent_tabs === "boolean"
        ? obj.auto_rename_agent_tabs
        : true,
    repositories: normalizedRepos,
    workspace_auto_sync: normalizedWorkspaceAutoSync,
    terminal_transport: Object.fromEntries(
      Object.entries(obj.terminal_transport ?? {}).flatMap(([key, value]) =>
        value &&
        typeof value === "object" &&
        typeof (value as { surface_codecs?: unknown }).surface_codecs ===
          "boolean"
          ? [
              [
                key,
                {
                  surface_codecs: (value as { surface_codecs: boolean })
                    .surface_codecs,
                },
              ],
            ]
          : [],
      ),
    ),
    custom:
      obj.custom && typeof obj.custom === "object"
        ? (obj.custom as Record<string, unknown>)
        : {},
    ui:
      obj.ui && typeof obj.ui === "object" && !Array.isArray(obj.ui)
        ? Object.fromEntries(
            Object.entries(obj.ui as Record<string, unknown>).filter(
              ([key, value]) =>
                uiSettingKeyIsValid(key) && uiSettingValueError(value) === null,
            ),
          )
        : {},
  };
}

export async function readGuiSettings(): Promise<GuiSettings> {
  if (cachedGuiSettings) return cachedGuiSettings;
  const path = guiSettingsPath();
  const file = Bun.file(path);
  if (!(await file.exists())) {
    cachedGuiSettings = defaultGuiSettings();
    return cachedGuiSettings;
  }
  try {
    cachedGuiSettings = normalizeGuiSettings(JSON.parse(await file.text()));
  } catch (e) {
    serverLogger.child("settings").warn("ignoring invalid settings", {
      path,
      error: e,
    });
    cachedGuiSettings = defaultGuiSettings();
  }
  return cachedGuiSettings;
}

async function persistGuiSettings(
  settings: GuiSettings,
  shouldCommit: () => boolean,
): Promise<GuiSettings> {
  const path = guiSettingsPath();
  const temporaryPath = `${path}.${process.pid}.${++temporaryFileSequence}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const normalized = normalizeGuiSettings(settings);
  try {
    if (!shouldCommit()) throw new Error("settings update cancelled");
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    if (!shouldCommit()) throw new Error("settings update cancelled");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  cachedGuiSettings = normalized;
  return normalized;
}

function enqueueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.then(operation);
  settingsMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Read and persist under one queue slot so background status updates cannot
// overwrite a toggle changed by an RPC that completed at the same time.
export function updateGuiSettings(
  update: (current: GuiSettings) => GuiSettings | Promise<GuiSettings>,
  shouldCommit: () => boolean = () => true,
): Promise<GuiSettings> {
  return enqueueSettingsMutation(async () => {
    const current = await readGuiSettings();
    if (!shouldCommit()) throw new Error("settings update cancelled");
    const next = await update(current);
    if (!shouldCommit()) throw new Error("settings update cancelled");
    return persistGuiSettings(next, shouldCommit);
  });
}

export function terminalSurfaceCodecsEnabled(
  settings: GuiSettings,
  connectionId = LEGACY_DEFAULT_CONNECTION_ID,
): boolean {
  return settings.terminal_transport?.[connectionId]?.surface_codecs !== false;
}

export function connectionSettingsPrefix(connectionId?: string | null): string {
  return connectionId && connectionId !== LEGACY_DEFAULT_CONNECTION_ID
    ? `connection:${encodeURIComponent(connectionId)}:`
    : "";
}

export function repoSettingsKey(
  rawRepoKey: string,
  host?: string | null,
  connectionId?: string | null,
): string {
  return `${connectionSettingsPrefix(connectionId)}${host ? `ssh:${host}` : "local"}:${rawRepoKey}`;
}

export function workspaceRepoSettingsKey(
  workspace: any,
  host?: string | null,
  connectionId?: string | null,
): string | null {
  const raw =
    (typeof workspace?.worktree?.repo_key === "string" &&
      workspace.worktree.repo_key) ||
    (typeof workspace?.worktree?.repo_root === "string" &&
      workspace.worktree.repo_root) ||
    workspaceSourceCheckoutPath(workspace);
  return raw ? repoSettingsKey(raw, host, connectionId) : null;
}

export function workspaceAutoSyncSettingsKey(
  checkoutPath: string,
  host?: string | null,
  connectionId?: string | null,
): string | null {
  const path = checkoutPath.trim();
  return path ? repoSettingsKey(path, host, connectionId) : null;
}

export async function repoWorktreeHooksEnabled(
  repoKey?: string | null,
): Promise<boolean> {
  if (!repoKey) return true;
  const settings = await readGuiSettings();
  return settings.repositories[repoKey]?.worktree_hooks_enabled !== false;
}
