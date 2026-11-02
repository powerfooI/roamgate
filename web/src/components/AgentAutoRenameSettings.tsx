import { useCallback, useEffect, useRef, useState } from "react";
import { Info, Sparkles } from "lucide-react";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const AUTO_RENAME_DESCRIPTION =
  "Names default tabs from the active agent session or its terminal title. " +
  "Existing custom names are preserved, including after reconnecting. " +
  "Custom names stop automatic updates; default tab names remain eligible.";

export function AgentAutoRenameSettings() {
  const client = useConnectionClient();
  const ready = useConnectionReady(client);
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
    pending.current = false;
    setSaving(false);
    setEnabled(null);
    setError(null);
    if (ready) void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [client, load, ready]);

  const save = async (value: boolean) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.agent_auto_rename.update", {
        enabled: value,
      });
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      if (typeof result?.enabled !== "boolean")
        throw new Error("Invalid auto-rename settings");
      setEnabled(result.enabled);
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setError((e as Error).message);
    } finally {
      if (mounted.current && request === sequence.current) {
        pending.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <Sparkles size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="agent-auto-rename-label">Automatic tab renaming</strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label="About automatic tab renaming"
                  title={AUTO_RENAME_DESCRIPTION}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label="About automatic tab renaming"
                aria-describedby="agent-auto-rename-description"
                collisionPadding={12}
              >
                {AUTO_RENAME_DESCRIPTION}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {saving
              ? "Saving..."
              : enabled === null
                ? error
                  ? "Unavailable"
                  : "Loading..."
                : enabled
                  ? "Update tab names from active agent sessions"
                  : "Disabled"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          id="agent-auto-rename-toggle"
          aria-labelledby="agent-auto-rename-label"
          aria-describedby="agent-auto-rename-description"
          aria-checked={enabled === true}
          disabled={enabled === null || saving || !client.isCurrent()}
          className={"settings-switch" + (enabled ? " is-on" : "")}
          onClick={() => {
            if (enabled !== null) void save(!enabled);
          }}
        >
          <span />
        </button>
      </div>
      <p id="agent-auto-rename-description" hidden>
        {AUTO_RENAME_DESCRIPTION}
      </p>
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
