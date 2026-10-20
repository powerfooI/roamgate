import { useEffect, useId, useRef, useState } from "react";
import type { ConnectionClient } from "../api";
import { formatUiDateTime } from "../uiLocale";
import "./CodexSessionLink.css";

type Preview = {
  token: string;
  session_id: string;
  cwd: string;
  path: string;
  updated_at: string;
};

export function CodexSessionLink({
  paneId,
  client,
  onLinked,
}: {
  paneId: string;
  client: ConnectionClient;
  onLinked: () => void;
}) {
  const inputId = useId();
  const [sessionId, setSessionId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit() {
    if (busy || !sessionId.trim() || !client.isCurrent()) return;
    setBusy(true);
    setMessage("");
    try {
      // Sequential SSH checks can exceed 30s; await the backend result or disconnect.
      if (preview) {
        await client.call(
          "agent_session.link",
          {
            pane_id: paneId,
            token: preview.token,
          },
          null,
        );
        if (!mounted.current || !client.isCurrent()) return;
        setPreview(null);
        setMessage("Session linked.");
        onLinked();
      } else {
        const result = await client.call(
          "agent_session.link_preview",
          {
            pane_id: paneId,
            session_id: sessionId.trim(),
          },
          null,
        );
        if (!mounted.current || !client.isCurrent()) return;
        setPreview(result as Preview);
      }
    } catch (error) {
      if (!mounted.current || !client.isCurrent()) return;
      setPreview(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current && client.isCurrent()) setBusy(false);
    }
  }

  return (
    <details className="codex-session-link">
      <summary>Link Codex session</summary>
      <form
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>
          Enter the ID of the conversation currently open in this pane. Linking
          also works with the shared Codex background server.
        </p>
        <label htmlFor={inputId}>Codex session ID</label>
        <input
          id={inputId}
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.target.value);
            setPreview(null);
            setMessage("");
          }}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          required
        />
        {preview ? (
          <div className="codex-session-link-preview">
            <span>Session: {preview.session_id}</span>
            <span>Directory: {preview.cwd || "Unknown"}</span>
            <span>Updated: {formatUiDateTime(preview.updated_at)}</span>
            <span>Transcript: {preview.path}</span>
            <p>
              Confirm this is the conversation currently shown in this pane.
              This replaces its existing session link for all viewers.
            </p>
          </div>
        ) : null}
        <button
          type="submit"
          className="secondary-btn"
          aria-disabled={busy || !sessionId.trim()}
        >
          {busy
            ? preview
              ? "Linking..."
              : "Checking..."
            : preview
              ? "Confirm session link"
              : "Check session"}
        </button>
        {message ? <p role="status">{message}</p> : null}
      </form>
    </details>
  );
}
