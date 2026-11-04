import { expect, test } from "bun:test";
import { DEFAULT_JIRA_PRESETS, type JiraConfigView } from "../../shared/jira";
import { issuePanelsVisible, jiraPanelAvailable } from "./issueTrackers";

const jira: JiraConfigView = {
  enabled: true,
  show_issue_panels: true,
  instance_type: "cloud",
  site_url: "https://acme.atlassian.net",
  cloud_id: "c",
  default_project: null,
  default_jql: "",
  sync_back_status: "In Review",
  presets: [...DEFAULT_JIRA_PRESETS],
  auth: { state: "authenticated" },
};

test("Jira and Tasks UI is hidden unless Jira is enabled and panels are on (AC63)", () => {
  expect(issuePanelsVisible(jira)).toBe(true);
  expect(issuePanelsVisible({ ...jira, enabled: false })).toBe(false);
  expect(issuePanelsVisible({ ...jira, show_issue_panels: false })).toBe(false);
  expect(issuePanelsVisible(null)).toBe(false);
});

test("the Jira panel also needs a working sign-in (AC28)", () => {
  expect(jiraPanelAvailable(jira)).toBe(true);
  expect(jiraPanelAvailable({ ...jira, auth: { state: "error" } })).toBe(false);
  expect(jiraPanelAvailable({ ...jira, enabled: false })).toBe(false);
});
