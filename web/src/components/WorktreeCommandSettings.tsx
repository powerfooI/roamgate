import { useEffect, useState } from "react";
import { useConnectionClient } from "../useConnectionClient";
import "./WorktreeCommandSettings.css";

/** Edits the default commands that create and remove worktrees. */
export function WorktreeCommandSettings() {
  const client = useConnectionClient();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savedRemove, setSavedRemove] = useState("");
  const [draftRemove, setDraftRemove] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("Loading...");

  useEffect(() => {
    let cancelled = false;
    client
      .call("settings.get")
      .then((result) => {
        if (cancelled || !client.isCurrent()) return;
        const command = result?.settings?.worktree_command ?? "";
        const removeCommand = result?.settings?.worktree_remove_command ?? "";
        setSaved(command);
        setDraft(command);
        setSavedRemove(removeCommand);
        setDraftRemove(removeCommand);
        setStatus("");
      })
      .catch((error) => {
        if (!cancelled) setStatus((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const save = async () => {
    setSaving(true);
    setStatus("Saving...");
    try {
      const result = await client.call("settings.worktree_command.update", {
        command: draft,
        remove_command: draftRemove,
      });
      const command = result?.worktree_command ?? "";
      const removeCommand = result?.worktree_remove_command ?? "";
      setSaved(command);
      setDraft(command);
      setSavedRemove(removeCommand);
      setDraftRemove(removeCommand);
      setStatus("Saved.");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changed = draft.trim() !== saved || draftRemove.trim() !== savedRemove;

  return (
    <form
      className="worktree-command-settings"
      aria-busy={saved === null || saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) void save();
      }}
    >
      <label htmlFor="worktree-command-default">New worktree command</label>
      <input
        id="worktree-command-default"
        type="text"
        value={draft}
        placeholder="git recworktree add {path} --branch {branch} --base {base}"
        disabled={saved === null || saving}
        spellCheck={false}
        autoComplete="off"
        aria-describedby="worktree-command-hint"
        onChange={(event) => setDraft(event.target.value)}
      />
      <p id="worktree-command-hint" className="worktree-command-hint">
        Runs in the source repository on the workspace's host instead of Herdr's
        worktree creation. {"{path}"}, {"{branch}"}, {"{base}"} and {"{repo}"}{" "}
        are replaced, shell-quoted. A repository's own command, set in its
        worktree dialog, wins. Leave empty to let Herdr create worktrees.
      </p>
      <label htmlFor="worktree-remove-command-default">
        Remove worktree command
      </label>
      <input
        id="worktree-remove-command-default"
        type="text"
        value={draftRemove}
        placeholder="git recworktree remove {path} {force}"
        disabled={saved === null || saving}
        spellCheck={false}
        autoComplete="off"
        aria-describedby="worktree-remove-command-hint"
        onChange={(event) => setDraftRemove(event.target.value)}
      />
      <p id="worktree-remove-command-hint" className="worktree-command-hint">
        Removes the checkout instead of Herdr, from its source repository; Herdr
        then closes the workspace. {"{path}"} and {"{repo}"} are replaced,
        shell-quoted, and {"{force}"} by --force when you force the removal.
        Leave empty to let Herdr remove worktrees.
      </p>
      <div className="worktree-command-actions">
        <span role="status">{status}</span>
        <button type="submit" disabled={saved === null || saving || !changed}>
          Save
        </button>
      </div>
    </form>
  );
}
