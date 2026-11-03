import { describe, expect, test } from "bun:test";
import {
  applyJiraConfigUpdate,
  defaultJiraSettings,
  jiraConfigView,
  normalizeIntegrationSettings,
  normalizeJiraSettings,
} from "./settings";

describe("Jira settings", () => {
  test("defaults: disabled, panels shown, two presets, assignee JQL", () => {
    const settings = defaultJiraSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.show_issue_panels).toBe(true);
    expect(settings.default_jql).toBe("assignee = currentUser()");
    expect(settings.sync_back_status).toBe("In Review");
    expect(settings.presets.map((preset) => preset.label)).toEqual([
      "Implement",
      "Investigate",
    ]);
    expect(settings.presets.map((preset) => preset.icon)).toEqual([
      "code",
      "search",
    ]);
  });

  test("normalization drops unknown keys and invalid values", () => {
    const settings = normalizeJiraSettings({
      enabled: true,
      site_url: "https://evil.example.com",
      default_project: "not a key",
      access_token: "secret",
      presets: [{ id: "x" }],
    })!;
    expect(settings.enabled).toBe(true);
    expect(settings.site_url).toBeUndefined();
    expect(settings.default_project).toBeUndefined();
    expect(settings.presets).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain("secret");
    expect(normalizeIntegrationSettings({ linear: {} })).toEqual({});
  });

  test("an invalid site URL rejects the whole update (AC16)", () => {
    const current = defaultJiraSettings();
    expect(() =>
      applyJiraConfigUpdate(current, {
        site_url: "https://acme.example.com",
        default_jql: "project = SDS",
      }),
    ).toThrow("atlassian.net");
  });

  test("changing the site clears its cloud ID and auth status", () => {
    const current = {
      ...defaultJiraSettings(),
      site_url: "https://acme.atlassian.net",
      cloud_id: "cloud-1",
      auth_account: "Ada",
      auth_checked_at: "2026-11-01T00:00:00.000Z",
    };
    const next = applyJiraConfigUpdate(current, {
      site_url: "https://other.atlassian.net/",
    });
    expect(next.site_url).toBe("https://other.atlassian.net");
    expect(next.cloud_id).toBeUndefined();
    expect(next.auth_account).toBeUndefined();
    const same = applyJiraConfigUpdate(current, {
      site_url: "https://ACME.atlassian.net",
    });
    expect(same.cloud_id).toBe("cloud-1");
  });

  test("validates project keys and sync-back status", () => {
    const current = defaultJiraSettings();
    expect(applyJiraConfigUpdate(current, { default_project: "SDS" })
      .default_project).toBe("SDS");
    expect(() =>
      applyJiraConfigUpdate(current, { default_project: "sds project" }),
    ).toThrow("project key");
    expect(() =>
      applyJiraConfigUpdate(current, { sync_back_status: " " }),
    ).toThrow("status");
  });
});

describe("jiraConfigView", () => {
  test("reports auth state without exposing credentials (AC2)", () => {
    const settings = {
      ...defaultJiraSettings(),
      enabled: true,
      site_url: "https://acme.atlassian.net",
      cloud_id: "cloud-1",
      auth_account: "Ada",
      auth_checked_at: "2026-11-01T00:00:00.000Z",
      // Defensive: even if a token were smuggled into settings it is not copied.
      access_token: "tok-access",
      refresh_token: "tok-refresh",
    } as ReturnType<typeof defaultJiraSettings>;
    const view = jiraConfigView(settings, true);
    expect(view.auth).toEqual({
      state: "authenticated",
      checked_at: "2026-11-01T00:00:00.000Z",
      account: "Ada",
    });
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("tok-access");
    expect(wire).not.toContain("tok-refresh");
    expect(wire).not.toContain("token");
  });

  test("not configured without credentials; error when the last check failed", () => {
    expect(jiraConfigView(undefined, false).auth.state).toBe("not_configured");
    const failed = {
      ...defaultJiraSettings(),
      site_url: "https://acme.atlassian.net",
      auth_error: "401",
    };
    expect(jiraConfigView(failed, true).auth.state).toBe("error");
  });
});
