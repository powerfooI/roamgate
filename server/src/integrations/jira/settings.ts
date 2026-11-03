import {
  DEFAULT_JIRA_JQL,
  DEFAULT_JIRA_PRESETS,
  DEFAULT_SYNC_BACK_STATUS,
  normalizeJiraSiteUrl,
  validateJiraPresets,
  type JiraConfigUpdate,
  type JiraConfigView,
  type JiraPreset,
} from "../../../../shared/jira";

/**
 * Non-secret Jira settings kept under `integrations.jira` in settings.json.
 * Tokens and the OAuth client registration live in the credential file
 * (./credentials.ts), never here.
 */
export type JiraSettings = {
  enabled: boolean;
  show_issue_panels: boolean;
  instance_type: "cloud";
  site_url?: string;
  cloud_id?: string;
  default_project?: string;
  default_jql: string;
  sync_back_status: string;
  presets: JiraPreset[];
  auth_checked_at?: string;
  auth_account?: string;
  auth_error?: string;
};

export type GuiIntegrationSettings = { jira?: JiraSettings };

export const JQL_MAX_LENGTH = 4000;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function defaultJiraSettings(): JiraSettings {
  return {
    enabled: false,
    show_issue_panels: true,
    instance_type: "cloud",
    default_jql: DEFAULT_JIRA_JQL,
    sync_back_status: DEFAULT_SYNC_BACK_STATUS,
    presets: DEFAULT_JIRA_PRESETS.map((preset) => ({ ...preset })),
  };
}

function optionalString(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

export function normalizeJiraSettings(raw: unknown): JiraSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const defaults = defaultJiraSettings();
  let presets = defaults.presets;
  try {
    if (obj.presets !== undefined) presets = validateJiraPresets(obj.presets);
  } catch {
    // Keep defaults rather than lose the whole integration to one bad preset.
  }
  const project = optionalString(obj.default_project, 64);
  return {
    enabled: obj.enabled === true,
    show_issue_panels: obj.show_issue_panels !== false,
    instance_type: "cloud",
    site_url: normalizeJiraSiteUrl(obj.site_url) ?? undefined,
    cloud_id: optionalString(obj.cloud_id, 128),
    default_project:
      project && PROJECT_KEY_RE.test(project) ? project : undefined,
    default_jql:
      typeof obj.default_jql === "string" &&
      obj.default_jql.length <= JQL_MAX_LENGTH
        ? obj.default_jql.trim()
        : defaults.default_jql,
    sync_back_status:
      optionalString(obj.sync_back_status, 120) ?? defaults.sync_back_status,
    presets,
    auth_checked_at: optionalString(obj.auth_checked_at, 64),
    auth_account: optionalString(obj.auth_account, 256),
    auth_error: optionalString(obj.auth_error, 1024),
  };
}

export function normalizeIntegrationSettings(
  raw: unknown,
): GuiIntegrationSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const jira = normalizeJiraSettings((raw as { jira?: unknown }).jira);
  return jira ? { jira } : {};
}

/**
 * Applies a browser update; throws with a user-facing message when a field is
 * invalid so nothing is saved (AC16).
 */
export function applyJiraConfigUpdate(
  current: JiraSettings,
  update: JiraConfigUpdate,
): JiraSettings {
  const next: JiraSettings = { ...current };
  if (update.enabled !== undefined) next.enabled = update.enabled === true;
  if (update.show_issue_panels !== undefined)
    next.show_issue_panels = update.show_issue_panels === true;
  if (update.site_url !== undefined) {
    if (update.site_url === null || update.site_url === "") {
      next.site_url = undefined;
    } else {
      const site = normalizeJiraSiteUrl(update.site_url);
      if (!site)
        throw new Error(
          "Enter an Atlassian Cloud site URL like https://your-site.atlassian.net.",
        );
      next.site_url = site;
    }
    if (next.site_url !== current.site_url) {
      // A different site needs its own cloud ID and a fresh sign-in.
      next.cloud_id = undefined;
      next.auth_account = undefined;
      next.auth_checked_at = undefined;
      next.auth_error = undefined;
    }
  }
  if (update.default_project !== undefined) {
    const project = update.default_project?.trim() || undefined;
    if (project && !PROJECT_KEY_RE.test(project))
      throw new Error("Choose a project key like SDS.");
    next.default_project = project;
  }
  if (update.default_jql !== undefined) {
    if (
      typeof update.default_jql !== "string" ||
      update.default_jql.length > JQL_MAX_LENGTH
    )
      throw new Error(`Default JQL is limited to ${JQL_MAX_LENGTH} characters.`);
    next.default_jql = update.default_jql.trim();
  }
  if (update.sync_back_status !== undefined) {
    const status =
      typeof update.sync_back_status === "string"
        ? update.sync_back_status.trim()
        : "";
    if (!status || status.length > 120)
      throw new Error("Enter the Jira status to move synced issues to.");
    next.sync_back_status = status;
  }
  if (update.presets !== undefined)
    next.presets = validateJiraPresets(update.presets);
  return next;
}

/** The browser's view: never includes tokens (AC2). */
export function jiraConfigView(
  settings: JiraSettings | undefined,
  hasCredentials: boolean,
): JiraConfigView {
  const value = settings ?? defaultJiraSettings();
  const state =
    !value.site_url || !hasCredentials
      ? value.auth_error && value.site_url
        ? "error"
        : "not_configured"
      : value.auth_error
        ? "error"
        : "authenticated";
  return {
    enabled: value.enabled,
    show_issue_panels: value.show_issue_panels,
    instance_type: value.instance_type,
    site_url: value.site_url ?? null,
    cloud_id: value.cloud_id ?? null,
    default_project: value.default_project ?? null,
    default_jql: value.default_jql,
    sync_back_status: value.sync_back_status,
    presets: value.presets.map((preset) => ({ ...preset })),
    auth: {
      state,
      ...(value.auth_checked_at ? { checked_at: value.auth_checked_at } : {}),
      ...(value.auth_account ? { account: value.auth_account } : {}),
      ...(value.auth_error ? { error: value.auth_error } : {}),
    },
  };
}
