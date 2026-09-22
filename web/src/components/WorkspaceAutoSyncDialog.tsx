import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "../store";
import { UI_LOCALE } from "../uiLocale";
import { useConnectionClient } from "../useConnectionClient";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./WorkspaceAutoSyncDialog.css";

type AutoSyncStatus = "updated" | "up_to_date" | "skipped" | "failed";

type WorkspaceAutoSyncInfo = {
  workspace_id: string;
  workspace_label?: string;
  checkout_path?: string | null;
  key: string;
  enabled: boolean;
  interval_minutes: number;
  last_run_at?: string;
  last_status?: AutoSyncStatus;
  last_message?: string;
  last_branch?: string;
  running: boolean;
};

export function WorkspaceAutoSyncDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [info, setInfo] = useState<WorkspaceAutoSyncInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const loadRequest = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!workspaceId) return;
      const requestId = ++loadRequest.current;
      if (showLoading) setLoading(true);
      try {
        const result = await connectionClient.call(
          "settings.workspace_auto_sync.get",
          { workspace_id: workspaceId },
        );
        if (connectionClient.isCurrent() && requestId === loadRequest.current) {
          setInfo(result as WorkspaceAutoSyncInfo);
          setError("");
        }
      } catch (loadError) {
        if (connectionClient.isCurrent() && requestId === loadRequest.current) {
          setError((loadError as Error).message);
        }
      } finally {
        if (
          showLoading &&
          connectionClient.isCurrent() &&
          requestId === loadRequest.current
        ) {
          setLoading(false);
        }
      }
    },
    [connectionClient, workspaceId],
  );

  useEffect(() => {
    if (!open || !workspaceId) return;
    setInfo(null);
    setSaving(false);
    setError("");
    void load(true);
    const timer = window.setInterval(() => void load(false), 3_000);
    return () => {
      window.clearInterval(timer);
      loadRequest.current += 1;
    };
  }, [load, open, workspaceId]);

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

  const setEnabled = async (enabled: boolean) => {
    if (!workspaceId || !connectionClient.isCurrent()) return;
    setSaving(true);
    setError("");
    const result = await store.setWorkspaceAutoSyncEnabled(
      workspaceId,
      enabled,
    );
    if (result && connectionClient.isCurrent()) await load(false);
    if (connectionClient.isCurrent()) setSaving(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal compact-modal workspace-auto-sync-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Automatic branch updates"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Automatic Branch Updates</h2>
          <CloseButton onClick={onClose} />
        </div>

        <p className="auto-sync-description">
          Every {info?.interval_minutes ?? 10} minutes, fetch{" "}
          <code>origin</code>&apos;s default branch and merge it into this
          workspace&apos;s current branch. A dirty workspace is skipped, and
          conflicting merges are aborted automatically. Updates run only while
          this workspace is open in the current Roamgate connection.
        </p>

        {loading ? (
          <div className="auto-sync-loading" role="status">
            <span className="hook-loading-mark" />
            <span>Loading automatic update settings...</span>
          </div>
        ) : (
          <>
            {error ? <p className="modal-error">{error}</p> : null}

            <div className="auto-sync-summary">
              <SummaryRow
                label="Workspace"
                value={info?.workspace_label ?? "-"}
              />
              <SummaryRow label="Checkout" value={info?.checkout_path ?? "-"} />
              <SummaryRow label="Branch" value={info?.last_branch ?? "-"} />
              <SummaryRow
                label="Last run"
                value={formatLastRun(info?.last_run_at)}
              />
            </div>

            <div className="auto-sync-toggle-row">
              <div>
                <strong>Keep branch updated</strong>
                <span>
                  {info?.running
                    ? "Syncing origin's default branch now..."
                    : statusLabel(info?.last_status)}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={info?.enabled ?? false}
                className={"settings-switch" + (info?.enabled ? " is-on" : "")}
                disabled={!info || saving}
                onClick={() => void setEnabled(!(info?.enabled ?? false))}
              >
                <span />
              </button>
            </div>

            {info?.last_message ? (
              <div
                className={
                  "auto-sync-result auto-sync-result-" +
                  (info.last_status ?? "unknown")
                }
              >
                {info.last_message}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="auto-sync-summary-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}

function formatLastRun(value?: string) {
  if (!value) return "Not run yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(UI_LOCALE);
}

function statusLabel(status?: AutoSyncStatus) {
  switch (status) {
    case "updated":
      return "Updated from origin's default branch";
    case "up_to_date":
      return "Already up to date";
    case "skipped":
      return "Last run was skipped";
    case "failed":
      return "Last run failed";
    default:
      return "No sync has run yet";
  }
}
