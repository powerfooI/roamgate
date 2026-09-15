import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "../store";
import { UI_LOCALE } from "../uiLocale";
import { useConnectionClient } from "../useConnectionClient";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./AutoSyncRepositoriesDialog.css";

type AutoSyncStatus = "updated" | "up_to_date" | "skipped" | "failed";

type AutoSyncConfig = {
  key: string;
  enabled: boolean;
  interval_minutes: number;
  checkout_path?: string;
  host?: string;
  last_run_at?: string;
  last_status?: AutoSyncStatus;
  last_message?: string;
  last_branch?: string;
  running?: boolean;
};

type AutoSyncConfigList = {
  configs: AutoSyncConfig[];
  path: string;
};

export function AutoSyncRepositoriesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [data, setData] = useState<AutoSyncConfigList | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      const requestId = ++requestSequence.current;
      if (showLoading) setLoading(true);
      try {
        const result = await connectionClient.call(
          "settings.workspace_auto_sync.list",
        );
        if (
          connectionClient.isCurrent() &&
          requestId === requestSequence.current
        ) {
          setData(result as AutoSyncConfigList);
          setError("");
        }
      } catch (loadError) {
        if (
          connectionClient.isCurrent() &&
          requestId === requestSequence.current
        ) {
          setError((loadError as Error).message);
        }
      } finally {
        if (
          showLoading &&
          connectionClient.isCurrent() &&
          requestId === requestSequence.current
        ) {
          setLoading(false);
        }
      }
    },
    [connectionClient],
  );

  useEffect(() => {
    if (!open) return;
    setData(null);
    setSavingKeys(new Set());
    setError("");
    void load(true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => {
      window.clearInterval(timer);
      requestSequence.current += 1;
    };
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    return focusDialogElement(dialogRef.current);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  const setEnabled = async (config: AutoSyncConfig, enabled: boolean) => {
    if (!connectionClient.isCurrent()) return;
    setSavingKeys((current) => new Set(current).add(config.key));
    const result = await store.setWorkspaceAutoSyncConfigEnabled(
      config.key,
      enabled,
    );
    if (result && connectionClient.isCurrent()) await load(false);
    if (!connectionClient.isCurrent()) return;
    setSavingKeys((current) => {
      const next = new Set(current);
      next.delete(config.key);
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal auto-sync-repositories-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Automatic branch update repositories"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>Automatic Branch Updates</h2>
            <p>Saved configurations run when their workspace is open</p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {loading ? (
          <div className="auto-sync-config-loading" role="status">
            <span className="hook-loading-mark" />
            <span>Loading repository configurations...</span>
          </div>
        ) : (
          <div className="auto-sync-config-content">
            {error ? <p className="modal-error">{error}</p> : null}
            {data?.configs.length ? (
              <div className="auto-sync-config-list">
                {data.configs.map((config) => {
                  const saving = savingKeys.has(config.key);
                  return (
                    <div className="auto-sync-config-item" key={config.key}>
                      <div className="auto-sync-config-main">
                        <div className="auto-sync-config-heading">
                          <strong>{configName(config)}</strong>
                          <span
                            className={
                              "auto-sync-status auto-sync-status-" +
                              (config.running
                                ? "syncing"
                                : (config.last_status ?? "idle"))
                            }
                          >
                            {config.running
                              ? "Syncing"
                              : statusLabel(config.last_status)}
                          </span>
                        </div>
                        <code title={configLocation(config)}>
                          {configLocation(config)}
                        </code>
                        <div className="auto-sync-config-meta">
                          <span>Every {config.interval_minutes} min</span>
                          <span>{formatLastRun(config.last_run_at)}</span>
                          {config.last_branch ? (
                            <span>Branch {config.last_branch}</span>
                          ) : null}
                        </div>
                        {config.last_message ? (
                          <p title={config.last_message}>
                            {config.last_message}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label={
                          "Automatic updates for " + configName(config)
                        }
                        aria-checked={config.enabled}
                        className={
                          "settings-switch" + (config.enabled ? " is-on" : "")
                        }
                        disabled={saving}
                        onClick={() => void setEnabled(config, !config.enabled)}
                      >
                        <span />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : error ? null : (
              <div className="auto-sync-config-empty">
                <strong>No saved repositories</strong>
                <span>
                  Enable automatic updates from a Workspace context menu first.
                </span>
              </div>
            )}
            {data?.path ? (
              <div className="auto-sync-config-store">
                <span>Settings</span>
                <code title={data.path}>{data.path}</code>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function configName(config: AutoSyncConfig) {
  const path = config.checkout_path || config.key;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function configLocation(config: AutoSyncConfig) {
  if (config.checkout_path) {
    return config.host
      ? config.host + ":" + config.checkout_path
      : config.checkout_path;
  }
  return config.key;
}

function statusLabel(status?: AutoSyncStatus) {
  switch (status) {
    case "updated":
      return "Updated";
    case "up_to_date":
      return "Up to date";
    case "skipped":
      return "Skipped";
    case "failed":
      return "Failed";
    default:
      return "Not run";
  }
}

function formatLastRun(value?: string) {
  if (!value) return "Never run";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : "Last run " + date.toLocaleString(UI_LOCALE);
}
