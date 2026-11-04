import { Check, ChevronRight, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  JIRA_PRESET_ICONS,
  JIRA_TEMPLATE_VARIABLES,
  normalizeJiraSiteUrl,
  validateJiraPresets,
  type JiraConfigView,
  type JiraPreset,
} from "../../../shared/jira";
import { callJira, updateJiraConfig, useIssueTrackers } from "../issueTrackers";
import { relativeAge } from "../issueTrackerFormat";
import { TrackerMark } from "./IssueTrackersSettings";
import { JiraPresetIcon } from "./JiraPresetIcon";
import { ConfirmDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import "./JiraSettingsPage.css";

type Draft = {
  site_url: string;
  default_project: string;
  default_jql: string;
  sync_back_status: string;
  presets: JiraPreset[];
};

function draftFrom(jira: JiraConfigView): Draft {
  return {
    site_url: jira.site_url ?? "",
    default_project: jira.default_project ?? "",
    default_jql: jira.default_jql,
    sync_back_status: jira.sync_back_status,
    presets: jira.presets.map((preset) => ({ ...preset })),
  };
}

const ICON_LABELS: Record<JiraPreset["icon"], string> = {
  code: "Code",
  search: "Search",
  bug: "Bug",
  wrench: "Wrench",
  sparkles: "Sparkles",
  file: "Document",
};

/** Configuration › Integrations › Jira (AC14–AC27). */
export function JiraSettingsPage({ onBack }: { onBack: () => void }) {
  const { jira } = useIssueTrackers();
  const [draft, setDraft] = useState<Draft | null>(() =>
    jira ? draftFrom(jira) : null,
  );
  const [siteError, setSiteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "save" | "test" | "connect" | "remove" | "toggle"
  >(null);
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [waitingForSignIn, setWaitingForSignIn] = useState(false);

  useEffect(() => {
    if (jira && !draft) setDraft(draftFrom(jira));
  }, [jira, draft]);

  const authenticated = jira?.auth.state === "authenticated";
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void callJira<{ projects: { key: string; name: string }[] }>("projects")
      .then((result) => {
        if (!cancelled) setProjects(result.projects);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authenticated, jira?.site_url]);

  // After the Atlassian window closes, poll briefly for the stored sign-in.
  useEffect(() => {
    if (!waitingForSignIn) return;
    if (authenticated) {
      setWaitingForSignIn(false);
      return;
    }
    const timer = window.setInterval(() => {
      void callJira("config.get").catch(() => undefined);
    }, 2000);
    const stop = window.setTimeout(() => setWaitingForSignIn(false), 5 * 60_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [waitingForSignIn, authenticated]);

  const projectOptions = useMemo(() => {
    const options = projects.map((project) => ({
      value: project.key,
      label: project.key,
      detail: project.name,
      keywords: [project.name],
    }));
    if (draft?.default_project && !projects.some((p) => p.key === draft.default_project))
      options.unshift({
        value: draft.default_project,
        label: draft.default_project,
        detail: "",
        keywords: [],
      });
    return [{ value: "", label: "No default", detail: "", keywords: [] }, ...options];
  }, [projects, draft?.default_project]);

  if (!jira || !draft)
    return <p className="configuration-scope">Loading Jira settings...</p>;

  const patch = (update: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...update } : current));

  const run = async (
    kind: NonNullable<typeof busy>,
    operation: () => Promise<unknown>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const validSite = normalizeJiraSiteUrl(draft.site_url);
  const save = async () => {
    if (draft.site_url.trim() && !validSite) {
      setSiteError(
        "Enter an Atlassian Cloud site URL like https://your-site.atlassian.net.",
      );
      return;
    }
    setSiteError(null);
    try {
      validateJiraPresets(draft.presets);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    const saved = await run("save", () =>
      updateJiraConfig({
        site_url: draft.site_url.trim() || null,
        default_project: draft.default_project || null,
        default_jql: draft.default_jql,
        sync_back_status: draft.sync_back_status,
        presets: draft.presets,
      }),
    );
    if (saved) onBack();
  };

  const connect = () =>
    run("connect", async () => {
      if (!validSite) {
        setSiteError("Enter your Atlassian site URL first.");
        return;
      }
      // Open the window before any await: browsers allow pop-ups only while
      // the click's user activation lasts.
      const opened = window.open("about:blank", "_blank");
      if (!opened)
        throw new Error(
          "Your browser blocked the Atlassian sign-in window. Allow pop-ups for Roamgate and try again.",
        );
      try {
        // Save the site first so the bridge signs in to the site shown here.
        if (validSite !== jira.site_url)
          await updateJiraConfig({ site_url: validSite });
        const { authorize_url } = await callJira<{ authorize_url: string }>(
          "oauth.start",
          { origin: window.location.origin },
        );
        opened.opener = null;
        opened.location.href = authorize_url;
        setWaitingForSignIn(true);
      } catch (cause) {
        opened.close();
        throw cause;
      }
    });

  const editingPreset = draft.presets.find((preset) => preset.id === editing);
  const updatePreset = (id: string, update: Partial<JiraPreset>) =>
    patch({
      presets: draft.presets.map((preset) =>
        preset.id === id ? { ...preset, ...update } : preset,
      ),
    });

  return (
    <div className="jira-settings-page">
      <div className="jira-settings-breadcrumb">
        <button type="button" className="jira-settings-crumb" onClick={onBack}>
          Integrations
        </button>
        <ChevronRight size={14} aria-hidden="true" />
        <TrackerMark kind="jira" />
        <strong>Jira</strong>
        <button
          type="button"
          role="switch"
          aria-label="Enable Jira"
          aria-checked={jira.enabled}
          disabled={busy !== null}
          className={"settings-switch" + (jira.enabled ? " is-on" : "")}
          onClick={() =>
            void run("toggle", () => updateJiraConfig({ enabled: !jira.enabled }))
          }
        >
          <span />
        </button>
      </div>

      <div className="jira-connection" data-state={jira.auth.state}>
        <div className="jira-connection-copy" role="status">
          {jira.auth.state === "authenticated" ? (
            <>
              <Check size={14} aria-hidden="true" />
              <strong>Authenticated</strong>
              <span>
                {jira.auth.account ? ` · ${jira.auth.account}` : ""}
                {jira.auth.checked_at
                  ? ` · checked ${relativeAge(jira.auth.checked_at)}`
                  : ""}
                {" · token refreshes automatically"}
              </span>
            </>
          ) : jira.auth.state === "error" ? (
            <>
              <TriangleAlert size={14} aria-hidden="true" />
              <strong>Not authenticated</strong>
              <span>{jira.auth.error ? ` · ${jira.auth.error}` : ""}</span>
            </>
          ) : (
            <span>
              {waitingForSignIn
                ? "Finish signing in in the Atlassian window..."
                : "Not connected. Enter your site URL, then connect with Atlassian."}
            </span>
          )}
        </div>
        <div className="jira-connection-actions">
          {jira.auth.state === "authenticated" || jira.auth.state === "error" ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("test", () => callJira("test"))}
            >
              {busy === "test" ? "Testing..." : "Test connection"}
            </button>
          ) : null}
          {jira.auth.state !== "authenticated" ? (
            <button
              type="button"
              className="jira-primary"
              disabled={busy !== null}
              onClick={() => void connect()}
            >
              {jira.auth.state === "error" ? "Authenticate" : "Connect with Atlassian"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="jira-settings-grid">
        <label className="jira-field">
          <span>Instance type</span>
          <select value="cloud" onChange={() => undefined} aria-label="Instance type">
            <option value="cloud">Atlassian Cloud</option>
            <option value="server" disabled>
              Server / Data Center (not supported yet)
            </option>
          </select>
        </label>
        <label className="jira-field">
          <span>Authentication</span>
          <select value="oauth" onChange={() => undefined} aria-label="Authentication">
            <option value="oauth">OAuth 2.0 (PKCE)</option>
          </select>
        </label>
        <label className="jira-field jira-field-wide">
          <span>Site URL</span>
          <input
            type="url"
            value={draft.site_url}
            placeholder="https://your-site.atlassian.net"
            aria-invalid={siteError ? true : undefined}
            aria-describedby={siteError ? "jira-site-error" : undefined}
            onChange={(event) => {
              patch({ site_url: event.target.value });
              setSiteError(null);
            }}
          />
          {siteError ? (
            <small id="jira-site-error" className="jira-field-error" role="alert">
              {siteError}
            </small>
          ) : null}
        </label>
        <div className="jira-field">
          <span id="jira-default-project">Default project</span>
          <ThemedSelect
            aria-label="Default project"
            value={draft.default_project}
            options={projectOptions}
            placeholder={authenticated ? "Choose a project" : "Connect to list projects"}
            searchPlaceholder="Search projects"
            emptyText="No projects found"
            disabled={!authenticated && projectOptions.length <= 1}
            onChange={(value) => patch({ default_project: value })}
          />
        </div>
        <label className="jira-field">
          <span>Default issue query</span>
          <input
            className="jira-mono"
            value={draft.default_jql}
            placeholder="assignee = currentUser()"
            spellCheck={false}
            onChange={(event) => patch({ default_jql: event.target.value })}
          />
        </label>
        <label className="jira-field jira-field-wide">
          <span>Sync-back status</span>
          <input
            value={draft.sync_back_status}
            placeholder="In Review"
            onChange={(event) => patch({ sync_back_status: event.target.value })}
          />
          <small>
            Synced tasks comment on their issue and move it to this status when
            they are marked done.
          </small>
        </label>
      </div>

      <section className="jira-presets" aria-labelledby="jira-presets-title">
        <div className="jira-presets-heading">
          <div>
            <strong id="jira-presets-title">Task presets</strong>
            <span>Prompt templates offered when creating a task from an issue</span>
          </div>
          <button
            type="button"
            onClick={() => {
              const id = `preset-${Date.now().toString(36)}`;
              patch({
                presets: [
                  ...draft.presets,
                  {
                    id,
                    label: "New preset",
                    icon: "sparkles",
                    hint: "",
                    template: "{{issue.key}}: {{issue.summary}}\n\n{{issue.description}}",
                  },
                ],
              });
              setEditing(id);
            }}
          >
            <Plus size={13} aria-hidden="true" /> Add preset
          </button>
        </div>
        <ul className="jira-preset-list">
          {draft.presets.map((preset) => (
            <li key={preset.id}>
              <JiraPresetIcon icon={preset.icon} />
              <div className="jira-preset-copy">
                <strong>{preset.label}</strong>
                <span>{preset.hint}</span>
              </div>
              <button
                type="button"
                aria-expanded={editing === preset.id}
                onClick={() =>
                  setEditing((current) => (current === preset.id ? null : preset.id))
                }
              >
                Edit prompt
              </button>
            </li>
          ))}
        </ul>
        {editingPreset ? (
          <div className="jira-preset-editor" aria-label={`Edit ${editingPreset.label}`}>
            <div className="jira-settings-grid">
              <label className="jira-field">
                <span>Label</span>
                <input
                  value={editingPreset.label}
                  maxLength={40}
                  onChange={(event) =>
                    updatePreset(editingPreset.id, { label: event.target.value })
                  }
                />
              </label>
              <label className="jira-field">
                <span>Icon</span>
                <select
                  value={editingPreset.icon}
                  onChange={(event) =>
                    updatePreset(editingPreset.id, {
                      icon: event.target.value as JiraPreset["icon"],
                    })
                  }
                >
                  {JIRA_PRESET_ICONS.map((icon) => (
                    <option key={icon} value={icon}>
                      {ICON_LABELS[icon]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="jira-field jira-field-wide">
                <span>Hint</span>
                <input
                  value={editingPreset.hint}
                  maxLength={120}
                  onChange={(event) =>
                    updatePreset(editingPreset.id, { hint: event.target.value })
                  }
                />
              </label>
              <label className="jira-field jira-field-wide">
                <span>Prompt template</span>
                <textarea
                  className="jira-mono"
                  rows={5}
                  value={editingPreset.template}
                  onChange={(event) =>
                    updatePreset(editingPreset.id, { template: event.target.value })
                  }
                />
                <small>
                  Variables:{" "}
                  {JIRA_TEMPLATE_VARIABLES.map((name) => `{{issue.${name}}}`).join(" ")}
                </small>
              </label>
            </div>
            <div className="jira-preset-editor-actions">
              <button
                type="button"
                className="jira-danger-link"
                onClick={() => {
                  patch({
                    presets: draft.presets.filter(
                      (preset) => preset.id !== editingPreset.id,
                    ),
                  });
                  setEditing(null);
                }}
              >
                Delete preset
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Done
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <div className="modal-actions jira-settings-actions">
        <button
          type="button"
          className="jira-danger-link"
          disabled={busy !== null}
          onClick={() => setConfirmRemove(true)}
        >
          Remove configuration
        </button>
        <span className="jira-settings-spacer" />
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="jira-primary"
          disabled={busy !== null}
          onClick={() => void save()}
        >
          {busy === "save" ? "Saving..." : "Save"}
        </button>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove Jira configuration?"
        message="This signs Roamgate out of Atlassian and deletes the Jira settings and presets. Tasks and their issue keys are kept."
        confirmLabel="Remove"
        danger
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void run("remove", async () => {
            const view = await callJira<JiraConfigView>("config.remove");
            setDraft(draftFrom(view));
            onBack();
          });
        }}
      />
    </div>
  );
}
