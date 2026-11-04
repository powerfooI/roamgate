import { ChevronRight, CircleDot } from "lucide-react";
import { useState } from "react";
import type { JiraConfigView } from "../../../shared/jira";
import { jiraSiteName } from "../../../shared/jira";
import { updateJiraConfig, useIssueTrackers } from "../issueTrackers";
import "./IssueTrackersSettings.css";

export function jiraStatusLine(jira: JiraConfigView | null): {
  text: string;
  tone: "success" | "error" | "muted";
} {
  if (!jira || (jira.auth.state === "not_configured" && !jira.site_url))
    return { text: "Not configured", tone: "muted" };
  if (jira.auth.state === "authenticated")
    return {
      text: [
        "Authenticated",
        jira.site_url ? new URL(jira.site_url).host : null,
        "OAuth 2.0",
      ]
        .filter(Boolean)
        .join(" · "),
      tone: "success",
    };
  if (jira.auth.state === "error")
    return { text: "Not authenticated", tone: "error" };
  return { text: "Not configured", tone: "muted" };
}

export function TrackerMark({ kind }: { kind: "jira" | "linear" | "github" }) {
  return (
    <span className="issue-tracker-mark" data-kind={kind} aria-hidden="true">
      {kind === "jira" ? "J" : kind === "linear" ? "L" : <CircleDot size={15} />}
    </span>
  );
}

/** Configuration › Integrations › Issue trackers (AC7–AC13). */
export function IssueTrackersSettings({
  onConfigureJira,
}: {
  onConfigureJira: () => void;
}) {
  const { jira, jiraError, supported, connectionStatus } = useIssueTrackers();
  const [saving, setSaving] = useState<null | "enabled" | "panels">(null);
  const [error, setError] = useState<string | null>(null);
  const status = jiraStatusLine(jira);
  const ready = supported && jira !== null;

  const save = async (
    field: "enabled" | "panels",
    update: Parameters<typeof updateJiraConfig>[0],
  ) => {
    setSaving(field);
    setError(null);
    try {
      await updateJiraConfig(update);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="issue-trackers-settings" aria-labelledby="issue-trackers-title">
      <div className="issue-trackers-heading">
        <strong id="issue-trackers-title">Issue trackers</strong>
        <span>Fetch issues into Roamgate and turn them into agent tasks</span>
      </div>
      {connectionStatus === "connected" && !supported ? (
        <p className="configuration-scope">
          This Roamgate server does not support issue trackers. Update it to
          use Jira.
        </p>
      ) : null}
      <ul className="issue-trackers-list">
        <li>
          <TrackerMark kind="jira" />
          <div className="issue-trackers-copy">
            <strong>Jira</strong>
            <span className="issue-trackers-status" data-tone={status.tone}>
              {status.tone !== "muted" ? (
                <span className="issue-trackers-dot" aria-hidden="true" />
              ) : null}
              {status.text}
              {jira?.site_url && status.tone !== "success"
                ? ` · ${jiraSiteName(jira.site_url)}`
                : null}
            </span>
          </div>
          <div className="issue-trackers-actions">
            <button
              type="button"
              aria-disabled={!ready}
              onClick={() => {
                if (ready) onConfigureJira();
              }}
            >
              Configure <ChevronRight size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              role="switch"
              aria-label="Enable Jira"
              aria-checked={jira?.enabled === true}
              disabled={!ready || saving !== null}
              className={"settings-switch" + (jira?.enabled ? " is-on" : "")}
              onClick={() =>
                jira && void save("enabled", { enabled: !jira.enabled })
              }
            >
              <span />
            </button>
          </div>
        </li>
        {(
          [
            ["linear", "Linear"],
            ["github", "GitHub Issues"],
          ] as const
        ).map(([kind, label]) => (
          <li key={kind} data-placeholder="true">
            <TrackerMark kind={kind} />
            <div className="issue-trackers-copy">
              <strong>{label}</strong>
              <span className="issue-trackers-status" data-tone="muted">
                Not configured
              </span>
            </div>
            <div className="issue-trackers-actions">
              <button
                type="button"
                disabled
                title="Not available yet"
                aria-label={`Connect ${label} (not available yet)`}
              >
                Connect
              </button>
              <button
                type="button"
                role="switch"
                aria-label={`Enable ${label} (not available yet)`}
                aria-checked={false}
                disabled
                title="Not available yet"
                className="settings-switch"
              >
                <span />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="config-preference-row issue-trackers-panels">
        <div className="config-item-copy">
          <strong id="issue-panels-label">Show issue panels in the sidebar</strong>
          <span id="issue-panels-hint">
            Adds Jira and Tasks entries to the tab bar and left panel when an
            integration is enabled
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby="issue-panels-label"
          aria-describedby="issue-panels-hint"
          aria-checked={jira?.show_issue_panels !== false}
          disabled={!ready || saving !== null}
          className={
            "settings-switch" +
            (jira?.show_issue_panels !== false ? " is-on" : "")
          }
          onClick={() =>
            jira &&
            void save("panels", { show_issue_panels: !jira.show_issue_panels })
          }
        >
          <span />
        </button>
      </div>
      {error || jiraError ? (
        <div className="configuration-error" role="alert">
          <span>{error ?? jiraError}</span>
        </div>
      ) : null}
    </section>
  );
}
