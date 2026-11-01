import { useCallback, useEffect, useRef, useState } from "react";
import { Info, Sparkles } from "lucide-react";
import { useConnectionClient } from "../useConnectionClient";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const AUTO_RENAME_DESCRIPTION =
  "Automatically updates the tab title with the session name when an agent " +
  "(such as Claude Code or Hermes) is active. Preserves custom names set manually " +
  "and keeps the session name after the agent finishes.";

export function AgentAutoRenameSettings() {
  const client = useConnectionClient();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.agent_auto_rename.get");
      if (typeof result?.enabled !== "boolean")
        throw new Error("Invalid auto-rename settings");
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setEnabled(result.enabled);
      setError(null);
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setEnabled(null);
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [client, load]);

  const save = async (value: boolean) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    sequence.current += 1;
    try {
      const result = await client.call("settings.agent_auto_rename.update", {
        enabled: value,
      });
      if (!mounted.current || !client.isCurrent()) return;
      setEnabled(result.enabled === true);
    } catch (e) {
      if (!mounted.current || !client.isCurrent()) return;
      setError((e as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className="terminal-transport-settings">
      <div className="terminal-transport-header">
        <label
          htmlFor="agent-auto-rename-toggle"
          className="terminal-transport-label"
        >
          <Sparkles size={16} />
          <span>Automatic tab renaming</span>
        </label>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-help-icon"
              aria-label="About automatic tab renaming"
            >
              <Info size={14} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="inline-help-popover" align="start">
            <p>{AUTO_RENAME_DESCRIPTION}</p>
          </PopoverContent>
        </Popover>
      </div>

      <div className="config-menu-item config-menu-item-toggle">
        <span>Update tab names from active agent sessions</span>
        <input
          id="agent-auto-rename-toggle"
          type="checkbox"
          role="switch"
          aria-label="Automatic tab renaming"
          disabled={saving || enabled === null}
          checked={enabled ?? true}
          onChange={(e) => void save(e.target.checked)}
        />
      </div>

      {error ? <div className="connection-error">{error}</div> : null}
    </div>
  );
}
