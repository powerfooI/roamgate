import { describe, expect, test } from "bun:test";
import {
  DEFAULT_JIRA_PRESETS,
  initialsFor,
  jiraBrowseUrl,
  normalizeJiraSiteUrl,
  renderJiraTemplate,
  validateJiraPresets,
  type JiraIssue,
} from "./jira";

const issue: JiraIssue = {
  key: "SDS-1679",
  summary: "Back button does not redirect",
  description: "Steps to reproduce",
  type: "Bug",
  status: "Selected for Development",
  status_category: "new",
  priority: "Low",
  assignee: { name: "Ada Lovelace", initials: "AL" },
  updated_at: "2026-11-01T00:00:00.000Z",
  url: "https://acme.atlassian.net/browse/SDS-1679",
};

describe("renderJiraTemplate", () => {
  test("replaces every documented issue variable", () => {
    expect(
      renderJiraTemplate(
        "{{issue.key}}|{{issue.summary}}|{{issue.description}}|{{issue.url}}|{{issue.type}}|{{issue.status}}|{{issue.priority}}|{{ issue.assignee }}",
        issue,
      ),
    ).toBe(
      "SDS-1679|Back button does not redirect|Steps to reproduce|https://acme.atlassian.net/browse/SDS-1679|Bug|Selected for Development|Low|Ada Lovelace",
    );
  });

  test("leaves unknown variables as written", () => {
    expect(renderJiraTemplate("{{issue.reporter}} {{task.id}}", issue)).toBe(
      "{{issue.reporter}} {{task.id}}",
    );
  });

  test("leaves the template unchanged without an issue", () => {
    expect(renderJiraTemplate("Fix {{issue.key}}", null)).toBe(
      "Fix {{issue.key}}",
    );
  });

  test("does not expand replacement patterns inside values", () => {
    expect(
      renderJiraTemplate("{{issue.summary}}", { ...issue, summary: "$& $1" }),
    ).toBe("$& $1");
  });
});

describe("normalizeJiraSiteUrl", () => {
  test("accepts Atlassian Cloud sites and normalizes them", () => {
    expect(normalizeJiraSiteUrl("https://Acme.atlassian.net/")).toBe(
      "https://acme.atlassian.net",
    );
  });

  test("rejects other URLs", () => {
    for (const value of [
      "http://acme.atlassian.net",
      "https://acme.atlassian.net/jira",
      "https://atlassian.net",
      "https://acme.example.com",
      "https://evil.com/.atlassian.net",
      42,
    ])
      expect(normalizeJiraSiteUrl(value)).toBeNull();
  });
});

test("jiraBrowseUrl links to the issue", () => {
  expect(jiraBrowseUrl("https://acme.atlassian.net/", "SDS-1")).toBe(
    "https://acme.atlassian.net/browse/SDS-1",
  );
});

test("initialsFor uses the first and last names", () => {
  expect(initialsFor("Lloyd van Leagas")).toBe("LL");
  expect(initialsFor("Cher")).toBe("C");
  expect(initialsFor("  ")).toBe("");
});

describe("validateJiraPresets", () => {
  test("accepts the default presets", () => {
    expect(validateJiraPresets([...DEFAULT_JIRA_PRESETS])).toEqual([
      ...DEFAULT_JIRA_PRESETS,
    ]);
  });

  test("rejects duplicates, unknown icons and empty prompts", () => {
    const base = DEFAULT_JIRA_PRESETS[0];
    expect(() => validateJiraPresets([base, base])).toThrow("unique id");
    expect(() => validateJiraPresets([{ ...base, icon: "rocket" }])).toThrow(
      "icon",
    );
    expect(() => validateJiraPresets([{ ...base, template: " " }])).toThrow(
      "prompts",
    );
    expect(() => validateJiraPresets([{ ...base, label: "" }])).toThrow(
      "labels",
    );
  });
});
