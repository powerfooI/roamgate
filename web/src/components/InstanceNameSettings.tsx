import { useCallback, useEffect, useRef, useState } from "react";
import {
  instanceDisplayName,
  MAX_TITLE_SUFFIX_LENGTH,
  normalizeTitleSuffix,
  type InstanceSettings,
} from "../../../shared/instanceName";
import { instanceNameClient, type InstanceNameClient } from "../instanceName";
import "./InstanceNameSettings.css";

export function InstanceNameSettings({
  client = instanceNameClient,
}: {
  client?: InstanceNameClient;
}) {
  const [saved, setSaved] = useState<InstanceSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<{
    kind: "load" | "save";
    message: string;
  } | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const sequence = useRef(0);

  let normalized = "";
  let validationError = "";
  try {
    normalized = normalizeTitleSuffix(draft);
  } catch (cause) {
    validationError = (cause as Error).message;
  }
  const changed = saved !== null && draft !== saved.title_suffix;

  const load = useCallback(async () => {
    if (pending.current) return;
    const current = ++sequence.current;
    setLoading(true);
    setError(null);
    setMessage("");
    try {
      const settings = await client.load();
      if (!mounted.current || current !== sequence.current) return;
      setSaved(settings);
      setDraft(settings.title_suffix);
    } catch (cause) {
      if (!mounted.current || current !== sequence.current) return;
      setSaved(null);
      setError({ kind: "load", message: (cause as Error).message });
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [load]);

  const save = async (suffix: string) => {
    if (pending.current || loading || !saved) return;
    const current = ++sequence.current;
    pending.current = true;
    setSaving(true);
    setError(null);
    setMessage("");
    setDraft(suffix);
    try {
      const settings = await client.save(suffix);
      if (!mounted.current || current !== sequence.current) return;
      setSaved(settings);
      setDraft(settings.title_suffix);
      setMessage("Saved for this Roamgate instance.");
    } catch (cause) {
      if (!mounted.current || current !== sequence.current) return;
      setError({ kind: "save", message: (cause as Error).message });
    } finally {
      pending.current = false;
      if (mounted.current && current === sequence.current) setSaving(false);
    }
  };

  return (
    <div className="instance-name-settings">
      <p className="instance-name-scope">
        Saved on this Roamgate server and shared across all devices and
        connections at this URL. Other Roamgate instances keep their own names.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!validationError && changed) void save(draft);
        }}
        aria-busy={loading || saving}
      >
        <label htmlFor="instance-title-suffix">
          App and webpage title suffix
        </label>
        <input
          id="instance-title-suffix"
          type="text"
          value={draft}
          placeholder="For example, Work or Home"
          disabled={loading || saving || !saved}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={Boolean(validationError)}
          aria-describedby="instance-name-hint instance-name-preview instance-name-validation"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            setMessage("");
          }}
        />
        <p id="instance-name-hint" className="instance-name-hint">
          Up to {MAX_TITLE_SUFFIX_LENGTH} characters. Extra spaces are trimmed.
          Leave empty for the default name, Roamgate.
        </p>
        <p
          id="instance-name-validation"
          role={validationError ? "alert" : undefined}
        >
          {validationError}
        </p>
        {saved ? (
          <div className="instance-name-preview" id="instance-name-preview">
            <p>
              Saved name:{" "}
              <strong>{instanceDisplayName(saved.title_suffix)}</strong>
            </p>
            {changed && !validationError ? (
              <p>
                Preview (not saved):{" "}
                <output>{instanceDisplayName(normalized)}</output>
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="instance-name-status" role="status">
          {loading
            ? "Loading instance name..."
            : saving
              ? "Saving..."
              : message}
        </p>
        {error ? (
          <div className="instance-name-error" role="alert">
            <span>{error.message}</span>
            <button
              type="button"
              disabled={loading || saving || Boolean(validationError)}
              onClick={() =>
                void (error.kind === "load" ? load() : save(draft))
              }
            >
              Retry
            </button>
          </div>
        ) : null}
        <div className="instance-name-actions">
          <button
            type="submit"
            disabled={
              loading ||
              saving ||
              !saved ||
              !changed ||
              Boolean(validationError)
            }
          >
            Save
          </button>
          <button
            type="button"
            disabled={
              loading ||
              saving ||
              !saved ||
              (saved.title_suffix === "" && draft === "")
            }
            onClick={() => void save("")}
          >
            Reset to default
          </button>
        </div>
      </form>
      <p className="instance-name-hint">
        Save before installing this instance as an app. Existing Android
        installs may need browser confirmation or reinstallation to update their
        launcher name. Reset to default saves the name Roamgate for this
        instance.
      </p>
    </div>
  );
}
