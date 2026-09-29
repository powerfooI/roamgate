import { useEffect, useRef, useState } from "react";
import { store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import type { WorktreeHookInfo } from "../worktreeLifecycle";
import { CloseButton } from "./CloseButton";
import "./WorktreeHooksDialog.css";

const HOOKS = [
  ["setup", "Setup"],
  ["opened", "Opened"],
  ["teardown", "Teardown"],
  ["removed", "Removed"],
] as const;

export function WorktreeHooksDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [info, setInfo] = useState<WorktreeHookInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const scopeKey = JSON.stringify([
    open,
    workspaceId ?? null,
    connectionClient.connectionId,
    connectionClient.generation,
  ]);
  const priorScopeKeyRef = useRef(scopeKey);
  const scopeVersionRef = useRef(0);
  if (priorScopeKeyRef.current !== scopeKey) {
    priorScopeKeyRef.current = scopeKey;
    scopeVersionRef.current += 1;
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    const scopeVersion = scopeVersionRef.current;
    const request = ++requestRef.current;
    const requestIsCurrent = () =>
      !cancelled &&
      scopeVersionRef.current === scopeVersion &&
      requestRef.current === request &&
      connectionClient.isCurrent();
    setLoading(true);
    setSaving(false);
    setError("");
    setInfo(null);
    connectionClient
      .call("settings.worktree_hooks.get", { workspace_id: workspaceId })
      .then((result) => {
        if (requestIsCurrent()) setInfo(result as WorktreeHookInfo);
      })
      .catch((err) => {
        if (requestIsCurrent()) setError((err as Error).message);
      })
      .finally(() => {
        if (requestIsCurrent()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionClient, open, scopeKey, workspaceId]);

  if (!open) return null;

  const setEnabled = async (enabled: boolean) => {
    if (!info?.key || !connectionClient.isCurrent()) return;
    const infoKey = info.key;
    const scopeVersion = scopeVersionRef.current;
    const request = ++requestRef.current;
    const requestIsCurrent = () =>
      scopeVersionRef.current === scopeVersion &&
      requestRef.current === request &&
      connectionClient.isCurrent();
    setSaving(true);
    setError("");
    try {
      const result = await store.setRepoWorktreeHooksEnabled(infoKey, enabled);
      if (!requestIsCurrent()) return;
      if (result === undefined) {
        setError(
          store.get().error || "Unable to update worktree hook settings",
        );
        return;
      }
      setInfo((current) =>
        current?.key === infoKey ? { ...current, enabled } : current,
      );
    } catch (err) {
      if (requestIsCurrent()) setError((err as Error).message);
    } finally {
      if (requestIsCurrent()) setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal worktree-hooks-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Worktree hooks"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Worktree Hooks</h2>
          <CloseButton onClick={onClose} />
        </div>
        <p className="hook-doc-note">
          Hooks use <code>roamgate.json</code>, with <code>paseo.json</code>{" "}
          supported for legacy compatibility.{" "}
          <a
            href="https://github.com/powerfooI/roamgate/blob/main/docs/DEPLOYMENT.md#worktree-hooks"
            target="_blank"
            rel="noreferrer"
          >
            View docs
          </a>
        </p>

        {loading ? (
          <div className="hook-loading" role="status">
            <span className="hook-loading-mark" />
            <span>Loading worktree hooks...</span>
          </div>
        ) : (
          <>
            {error || info?.error ? (
              <p className="modal-error">{error || info?.error}</p>
            ) : null}

            <div className="hook-summary">
              <SummaryRow label="Repo" value={info?.repo_name ?? "-"} />
              <SummaryRow label="Store key" value={info?.key ?? "-"} />
              <SummaryRow
                label="Configuration"
                value={info?.config_path ?? "-"}
              />
              <SummaryRow
                label="Format"
                value={
                  info?.config_source === "paseo"
                    ? "paseo.json (legacy compatibility)"
                    : info?.config_source === "roamgate"
                      ? "roamgate.json (native)"
                      : "-"
                }
              />
              <SummaryRow label="Checkout" value={info?.checkout_path ?? "-"} />
            </div>

            <label className="check-row">
              <input
                type="checkbox"
                checked={info?.enabled ?? true}
                disabled={!info?.key || saving}
                onChange={(e) => void setEnabled(e.currentTarget.checked)}
              />
              <span>
                {saving ? "Saving..." : "Enable worktree hooks for this repo"}
              </span>
            </label>

            <div className="hook-fields">
              {HOOKS.map(([name, label]) => {
                const value = info?.hooks?.[name] ?? "";
                return (
                  <section key={name} className="hook-field">
                    <span>{label}</span>
                    <pre className={value ? "" : "is-empty"}>
                      <code>{value || "Not configured"}</code>
                    </pre>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hook-summary-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}
