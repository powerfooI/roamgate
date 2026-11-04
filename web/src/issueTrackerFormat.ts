import {
  DEFAULT_JIRA_JQL,
  type JiraConfigView,
  type JiraFilters,
} from "../../shared/jira";
import { formatUiRelativeTime } from "./uiLocale";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "4 days ago", "1 minute ago", "now". */
export function relativeAge(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size)
      return formatUiRelativeTime(Math.round(seconds / size), unit);
  return formatUiRelativeTime(0, "second");
}

/** Compact elapsed time for running tasks: "45s", "6m", "2h 5m". */
export function elapsedLabel(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return "";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export type JiraQuery = { mode: "filters"; filters: JiraFilters } | {
  mode: "jql";
  jql: string;
};

/**
 * The panel's first query (AC32): the default project, plus the default JQL.
 * JQL the structured filters can express stays structured; anything else
 * opens in raw JQL mode, scoped to the default project.
 */
export function initialJiraQuery(
  jira: Pick<JiraConfigView, "default_project" | "default_jql">,
): JiraQuery {
  const project = jira.default_project ?? undefined;
  const jql = jira.default_jql.trim();
  const base: JiraFilters = {
    ...(project ? { project } : {}),
    sort: { field: "updated", dir: "desc" },
  };
  if (!jql) return { mode: "filters", filters: { ...base, assignee: "any" } };
  if (jql === DEFAULT_JIRA_JQL)
    return { mode: "filters", filters: { ...base, assignee: "me" } };
  if (jql === "assignee is EMPTY")
    return { mode: "filters", filters: { ...base, assignee: "unassigned" } };
  if (!project) return { mode: "jql", jql };
  // Keep a trailing ORDER BY outside the parentheses.
  const match = /^(.*?)(\s*\bORDER\s+BY\b.*)?$/is.exec(jql)!;
  const where = match[1].trim();
  const order = match[2]?.trim() ?? "";
  return {
    mode: "jql",
    jql: [
      where ? `project = "${project}" AND (${where})` : `project = "${project}"`,
      order,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
