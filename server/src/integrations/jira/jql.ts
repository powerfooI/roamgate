import type { JiraFilters, JiraSortField } from "../../../../shared/jira";

/** Quotes a JQL string literal; follows Kandev's filter model. */
export function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_LIST = 50;
const MAX_VALUE = 200;

function list(values: string[] | undefined): string[] {
  return (values ?? [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value && value.length <= MAX_VALUE)
    .slice(0, MAX_LIST);
}

const SORT_FIELDS: Record<JiraSortField, string> = {
  updated: "updated",
  created: "created",
  priority: "priority",
  key: "key",
};

/** Builds JQL from the panel's structured filters (AC34). */
export function buildJql(filters: JiraFilters = {}): string {
  const clauses: string[] = [];
  const project = filters.project?.trim();
  if (project && project.length <= MAX_VALUE)
    clauses.push(`project = ${jqlQuote(project)}`);
  const types = list(filters.types);
  if (types.length)
    clauses.push(`issuetype in (${types.map(jqlQuote).join(", ")})`);
  const statuses = list(filters.statuses);
  if (statuses.length)
    clauses.push(`status in (${statuses.map(jqlQuote).join(", ")})`);
  if (filters.assignee === "me") clauses.push("assignee = currentUser()");
  else if (filters.assignee === "unassigned") clauses.push("assignee is EMPTY");
  const text = filters.text?.trim().slice(0, MAX_VALUE);
  if (text) {
    clauses.push(
      ISSUE_KEY_RE.test(text.toUpperCase())
        ? `key = ${jqlQuote(text.toUpperCase())}`
        : `text ~ ${jqlQuote(text)}`,
    );
  }
  const field = SORT_FIELDS[filters.sort?.field ?? "updated"] ?? "updated";
  const dir = filters.sort?.dir === "asc" ? "ASC" : "DESC";
  const order =
    field === "updated"
      ? `ORDER BY updated ${dir}`
      : `ORDER BY ${field} ${dir}, updated DESC`;
  return clauses.length ? `${clauses.join(" AND ")} ${order}` : order;
}
