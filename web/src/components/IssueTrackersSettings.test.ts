import { expect, test } from "bun:test";
import { DEFAULT_JIRA_PRESETS, type JiraConfigView } from "../../../shared/jira";
import { jiraStatusLine } from "./IssueTrackersSettings";

const base: JiraConfigView = {
  enabled: true,
  show_issue_panels: true,
  instance_type: "cloud",
  site_url: "https://ilevelandbeyond.atlassian.net",
  cloud_id: "c",
  default_project: null,
  default_jql: "",
  sync_back_status: "In Review",
  presets: [...DEFAULT_JIRA_PRESETS],
  auth: { state: "authenticated" },
};

test("Jira row status line (AC9)", () => {
  expect(jiraStatusLine(base)).toEqual({
    text: "Authenticated · ilevelandbeyond.atlassian.net · OAuth 2.0",
    tone: "success",
  });
  expect(jiraStatusLine({ ...base, auth: { state: "error", error: "x" } }).text).toBe(
    "Not authenticated",
  );
  expect(jiraStatusLine({ ...base, site_url: null, auth: { state: "not_configured" } }).text).toBe(
    "Not configured",
  );
  expect(jiraStatusLine(null).text).toBe("Not configured");
});
