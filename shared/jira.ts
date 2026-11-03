// Jira wire types and helpers shared by the bridge and the browser. Tokens and
// OAuth client state never appear here: they stay in the bridge's private
// credential file.

export type JiraInstanceType = "cloud";

export const JIRA_PRESET_ICONS = [
  "code",
  "search",
  "bug",
  "wrench",
  "sparkles",
  "file",
] as const;
export type JiraPresetIcon = (typeof JIRA_PRESET_ICONS)[number];

export type JiraPreset = {
  id: string;
  label: string;
  icon: JiraPresetIcon;
  hint: string;
  template: string;
};

export type JiraAuthState = "not_configured" | "authenticated" | "error";

/** What the browser may see of the Jira integration. Never carries tokens. */
export type JiraConfigView = {
  enabled: boolean;
  show_issue_panels: boolean;
  instance_type: JiraInstanceType;
  site_url: string | null;
  cloud_id: string | null;
  default_project: string | null;
  default_jql: string;
  sync_back_status: string;
  presets: JiraPreset[];
  auth: {
    state: JiraAuthState;
    checked_at?: string;
    account?: string;
    error?: string;
  };
};

export type JiraConfigUpdate = Partial<
  Pick<
    JiraConfigView,
    | "enabled"
    | "show_issue_panels"
    | "site_url"
    | "default_project"
    | "default_jql"
    | "sync_back_status"
    | "presets"
  >
>;

export type JiraIssue = {
  key: string;
  summary: string;
  description: string;
  type: string;
  status: string;
  status_category: "new" | "indeterminate" | "done";
  priority: string | null;
  assignee: { name: string; initials: string } | null;
  updated_at: string;
  url: string;
};

export type JiraAssigneeFilter = "me" | "unassigned" | "any";
export type JiraSortField = "updated" | "created" | "priority" | "key";

export type JiraFilters = {
  text?: string;
  project?: string;
  types?: string[];
  statuses?: string[];
  assignee?: JiraAssigneeFilter;
  sort?: { field: JiraSortField; dir: "asc" | "desc" };
};

export type JiraSearchResult = {
  issues: JiraIssue[];
  next_page_token: string | null;
  jql: string;
};

export type JiraSavedView = {
  id: string;
  name: string;
  filters?: JiraFilters;
  jql?: string;
};

export const JIRA_PAGE_SIZE = 25;
export const DEFAULT_JIRA_JQL = "assignee = currentUser()";
export const DEFAULT_SYNC_BACK_STATUS = "In Review";
export const JIRA_SAVED_VIEWS_UI_KEY = "jiraSavedViews";

export const DEFAULT_JIRA_PRESETS: readonly JiraPreset[] = [
  {
    id: "implement",
    label: "Implement",
    icon: "code",
    hint: "Build the change, open a PR",
    template:
      "Implement {{issue.key}}: {{issue.summary}}. Read the description and acceptance criteria, make the change, add tests, and open a merge request linking the issue.\n\n{{issue.description}}",
  },
  {
    id: "investigate",
    label: "Investigate",
    icon: "search",
    hint: "Find the root cause",
    template:
      "Investigate {{issue.key}}: {{issue.summary}}. Find the root cause, explain it with evidence from the code, and propose a fix. Do not change code yet.\n\n{{issue.description}}",
  },
];

export const JIRA_TEMPLATE_VARIABLES = [
  "key",
  "summary",
  "description",
  "url",
  "type",
  "status",
  "priority",
  "assignee",
] as const;

/**
 * Replaces `{{issue.<name>}}` with the issue's value. Unknown variables, and
 * every variable when no issue is linked, are left exactly as written.
 */
export function renderJiraTemplate(
  template: string,
  issue: JiraIssue | null | undefined,
): string {
  if (!issue) return template;
  const values: Record<(typeof JIRA_TEMPLATE_VARIABLES)[number], string> = {
    key: issue.key,
    summary: issue.summary,
    description: issue.description,
    url: issue.url,
    type: issue.type,
    status: issue.status,
    priority: issue.priority ?? "",
    assignee: issue.assignee?.name ?? "Unassigned",
  };
  return template.replace(
    /\{\{\s*issue\.([A-Za-z_]+)\s*\}\}/g,
    (match, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name)
        ? values[name as keyof typeof values]
        : match,
  );
}

const SITE_URL_RE = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net\/?$/i;

/** Returns `https://<name>.atlassian.net`, or null for any other URL. */
export function normalizeJiraSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = SITE_URL_RE.exec(value.trim());
  return match ? `https://${match[1].toLowerCase()}.atlassian.net` : null;
}

export function jiraSiteName(siteUrl: string | null | undefined): string {
  if (!siteUrl) return "";
  try {
    return new URL(siteUrl).hostname.replace(/\.atlassian\.net$/, "");
  } catch {
    return "";
  }
}

export function jiraBrowseUrl(siteUrl: string, key: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

const PRESET_LIMITS = { label: 40, hint: 120, template: 8000, count: 20 };

/** Validates browser-supplied presets; throws with a user-facing message. */
export function validateJiraPresets(value: unknown): JiraPreset[] {
  if (!Array.isArray(value)) throw new Error("Presets must be a list.");
  if (value.length > PRESET_LIMITS.count)
    throw new Error(`At most ${PRESET_LIMITS.count} presets are allowed.`);
  const ids = new Set<string>();
  return value.map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const hint = typeof entry.hint === "string" ? entry.hint.trim() : "";
    const template = typeof entry.template === "string" ? entry.template : "";
    const icon = entry.icon;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id))
      throw new Error("Each preset needs a unique id.");
    if (!label || label.length > PRESET_LIMITS.label)
      throw new Error(
        `Preset labels need 1 to ${PRESET_LIMITS.label} characters.`,
      );
    if (hint.length > PRESET_LIMITS.hint)
      throw new Error(`Preset hints are limited to ${PRESET_LIMITS.hint} characters.`);
    if (!template.trim() || template.length > PRESET_LIMITS.template)
      throw new Error(
        `Preset prompts need 1 to ${PRESET_LIMITS.template} characters.`,
      );
    if (!JIRA_PRESET_ICONS.includes(icon as JiraPresetIcon))
      throw new Error("Choose a preset icon from the list.");
    ids.add(id);
    return { id, label, hint, template, icon: icon as JiraPresetIcon };
  });
}

/**
 * RPC errors carry only a message, so auth failures use a fixed prefix the
 * browser can recognise to offer a link to the Jira settings (AC42).
 */
export const JIRA_AUTH_ERROR_PREFIX = "Jira sign-in required";

export function isJiraAuthError(message: string | null | undefined): boolean {
  return !!message && message.startsWith(JIRA_AUTH_ERROR_PREFIX);
}
