import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Folder } from "lucide-react";
import type { WorkspacePathInfo } from "../../../shared/workspacePath";
import type { ConnectionClient } from "../api";
import { luckyWorkspaceName } from "../luckyName";
import { store, useEndpointCreationReason } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./CreateWorkspaceDialog.css";

export function CreateWorkspaceDialog({
  open,
  initialName,
  initialCwd,
  onClose,
}: {
  open: boolean;
  initialName?: string;
  initialCwd?: string;
  onClose: () => void;
}) {
  const createReason = useEndpointCreationReason("workspace.create");
  const client = useConnectionClient();
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  const [pathState, setPathState] = useState<{
    client: ConnectionClient;
    input: string;
    info?: WorkspacePathInfo;
    error?: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const pendingSubmit = useRef<symbol | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const cwdRef = useRef<HTMLInputElement>(null);
  const pathHintId = useId();
  const onCloseEvent = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    setLabel(initialName?.trim() || luckyWorkspaceName());
    setCwd(initialCwd?.trim() ?? "");
    const cancelFocus = focusDialogElement(labelRef.current, { select: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey);
    };
  }, [open, initialName, initialCwd]);

  useEffect(() => {
    setCreating(false);
    setCreateError("");
    setPathState(null);
    return () => {
      pendingSubmit.current = null;
    };
  }, [open, client]);

  const input = cwd.trim();
  useEffect(() => {
    if (!open || !input) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void client.call("workspace.path", { path: input }).then(
        (info: WorkspacePathInfo) => {
          if (!cancelled && client.isCurrent())
            setPathState({ client, input, info });
        },
        (error: Error) => {
          if (!cancelled && client.isCurrent())
            setPathState({ client, input, error: error.message });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, client, input]);

  if (!open) return null;

  const checked =
    pathState?.client === client && pathState.input === input
      ? pathState
      : null;
  const pathError = checked?.error || checked?.info?.error;
  const checking = !!input && !checked;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      createReason ||
      pendingSubmit.current ||
      checking ||
      pathError ||
      !client.isCurrent()
    )
      return;
    const submission = Symbol();
    pendingSubmit.current = submission;
    setCreating(true);
    setCreateError("");
    const result = await store.createWorkspace(
      label.trim() || undefined,
      input ? checked?.info?.path : undefined,
    );
    if (pendingSubmit.current !== submission || !client.isCurrent()) return;
    pendingSubmit.current = null;
    setCreating(false);
    if (result) onClose();
    else
      setCreateError(
        store.get().error ||
          "Workspace creation failed. Check the directory and retry.",
      );
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create workspace"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Create Workspace</h2>
          <CloseButton onClick={onClose} />
        </div>

        <label className="form-field">
          <span>Name</span>
          <input
            ref={labelRef}
            value={label}
            disabled={creating}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="Optional"
          />
        </label>

        <label className="form-field">
          <span>Working directory</span>
          <input
            ref={cwdRef}
            value={cwd}
            onChange={(e) => {
              setCwd(e.currentTarget.value);
              setCreateError("");
            }}
            placeholder="Optional, e.g. ~/Developer/project"
            spellCheck={false}
            autoComplete="off"
            disabled={creating}
            aria-invalid={!!pathError}
            aria-describedby={pathHintId}
          />
        </label>
        <div id={pathHintId} className="workspace-path-hint" aria-live="polite">
          {checking ? (
            <p role="status">Checking directory...</p>
          ) : pathError ? (
            <p className="modal-error" role="alert">
              {pathError}
            </p>
          ) : checked?.info ? (
            <p>
              Directory: <code>{checked.info.path}</code>
            </p>
          ) : (
            <p>
              Use an absolute path or ~/ on the connected host. Leave blank to
              use the default directory.
            </p>
          )}
        </div>
        {checked?.info?.directories.length ? (
          <div
            className="workspace-path-directories"
            role="list"
            aria-label="Directory suggestions"
          >
            {checked.info.directories.map((directory) => (
              <div key={directory} role="listitem">
                <button
                  type="button"
                  className="ghost"
                  disabled={creating}
                  title={directory}
                  onClick={() => {
                    setCwd(
                      directory.endsWith("/") ? directory : `${directory}/`,
                    );
                    setCreateError("");
                    cwdRef.current?.focus();
                  }}
                >
                  <Folder size={14} aria-hidden="true" />
                  <span>
                    {directory
                      .split(directory.startsWith("/") ? "/" : /[/\\]/)
                      .filter(Boolean)
                      .pop()}
                    /
                  </span>
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {createError ? (
          <p className="modal-error" role="alert">
            {createError}
          </p>
        ) : null}
        {createReason ? <p role="status">{createReason}</p> : null}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!!createReason || creating || checking || !!pathError}
            title={createReason ?? undefined}
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
