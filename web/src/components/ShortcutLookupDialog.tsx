import { useEffect, useRef, useState } from "react";
import { CloseButton } from "./CloseButton";
import { ThemedSelect } from "./ThemedSelect";
import { focusDialogElement } from "./dialogFocus";
import { SHORTCUT_CATALOG } from "../shortcutCatalog";
import {
  defaultShortcutBindings,
  formatShortcut,
  SHORTCUT_PLATFORMS,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutWarning,
  validateShortcutKeys,
  type ShortcutId,
} from "../shortcutBindings";
import {
  deleteShortcutPreset,
  exportShortcutPreset,
  importShortcutPreset,
  saveShortcutPreset,
  selectShortcutPreset,
  updateShortcut,
  useShortcutPreferences,
} from "../shortcutPreferences";
import "./ShortcutLookupDialog.css";

export function ShortcutLookupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { preferences, platform, preset, storageError } =
    useShortcutPreferences();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<ShortcutId | null>(null);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const custom = preferences.presets.some((item) => item.id === preset.id);
  const format = (keys: string[]) =>
    keys.map((key) => formatShortcut(key, platform)).join(" / ") ||
    "Unassigned";
  const clearEditor = () => {
    setEditing(null);
    setRecording(false);
    setError("");
    setDeleting(false);
  };
  const attempt = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const cancelFocus = focusDialogElement(dialogRef.current);
    return () => {
      cancelFocus();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
      else
        document
          .querySelector<HTMLButtonElement>('button[aria-label="Menu"]')
          ?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (recording) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape") {
          setRecording(false);
          return;
        }
        if (["Control", "Alt", "Meta", "Shift"].includes(event.key)) return;
        const binding = shortcutFromEvent(event);
        if (!binding) {
          setError("That key cannot be recorded. Try another combination.");
          return;
        }
        setDraft(binding);
        setRecording(false);
        setError("");
        saveRef.current?.focus();
      } else if (event.key === "Escape") {
        // An open popover (themed select) consumes Escape to close itself.
        if (document.querySelector(".popover-content")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (editing) setEditing(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, recording, editing, onClose]);
  if (!open) return null;

  const visible = SHORTCUT_CATALOG.filter((item) =>
    `${item.label} ${item.group} ${format(preset.bindings[item.id])}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const groups = [...new Set(visible.map((item) => item.group))];
  const exportPreset = () => {
    const url = URL.createObjectURL(
      new Blob([exportShortcutPreset(preset)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${preset.name.replace(/[^a-z0-9-]/gi, "-")}-keybindings.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Clicks inside portaled popovers bubble here through the React tree.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal shortcut-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled):not([type="file"]), select:not(:disabled)',
            ),
          ];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="modal-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <p>Choose a preset or customize shortcuts for this browser.</p>
          </div>
          <CloseButton label="Close keyboard shortcuts" onClick={onClose} />
        </div>
        <div className="keybinding-settings">
          <label className="keybinding-preset">
            <span>Active preset</span>
            <ThemedSelect
              aria-label="Active preset"
              value={preferences.active}
              options={[
                {
                  value: "auto",
                  label: `Automatic (${SHORTCUT_PLATFORMS[platform]})`,
                },
                ...Object.entries(SHORTCUT_PLATFORMS).map(([id, label]) => ({
                  value: id,
                  label,
                })),
                ...preferences.presets.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
              onChange={(preset) =>
                attempt(() => {
                  selectShortcutPreset(preset);
                  clearEditor();
                })
              }
            />
          </label>
          <div className="keybinding-preset-actions">
            <input
              aria-label="New preset name"
              placeholder="New preset name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              disabled={!name.trim()}
              onClick={() =>
                attempt(() => {
                  saveShortcutPreset(name);
                  setName("");
                  clearEditor();
                })
              }
            >
              Save as
            </button>
            <button type="button" className="ghost" onClick={exportPreset}>
              Export
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => fileRef.current?.click()}
            >
              Import
            </button>
            {custom ? (
              <button
                type="button"
                className="ghost danger"
                onClick={() => setDeleting(!deleting)}
              >
                Delete
              </button>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  if (file.size > 100_000)
                    throw new Error(
                      "Preset files must be smaller than 100 KB.",
                    );
                  const imported = importShortcutPreset(await file.text());
                  saveShortcutPreset(imported.name, imported);
                  clearEditor();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </div>
          {deleting ? (
            <div className="keybinding-delete">
              <span>Delete “{preset.name}”?</span>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  deleteShortcutPreset(preset.id);
                  clearEditor();
                }}
              >
                Delete preset
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setDeleting(false)}
              >
                Cancel
              </button>
            </div>
          ) : null}
          <p className="muted">
            Detected {SHORTCUT_PLATFORMS[platform]}.{" "}
            {custom
              ? "Edits save to this preset immediately."
              : "Editing a built-in preset creates a custom copy."}
          </p>
          <input
            type="search"
            aria-label="Search shortcuts"
            placeholder="Search shortcuts..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {error || storageError ? (
            <p className="keybinding-error" role="alert">
              {error || storageError}
            </p>
          ) : null}
        </div>
        <div className="shortcut-list">
          {groups.map((group) => (
            <section className="shortcut-section" key={group}>
              <h3>{group}</h3>
              <dl>
                {visible
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <div
                      className="shortcut-row"
                      key={item.id}
                      data-shortcut-id={item.id}
                    >
                      <dt>{item.label}</dt>
                      <dd>
                        <button
                          type="button"
                          className="keybinding-edit ghost"
                          aria-label={`Edit ${item.label}`}
                          onClick={() => {
                            setEditing(item.id);
                            setDraft(preset.bindings[item.id].join("; "));
                            setRecording(false);
                            setError("");
                          }}
                        >
                          <kbd>{format(preset.bindings[item.id])}</kbd>
                          <span>Edit</span>
                        </button>
                      </dd>
                      {editing === item.id ? (
                        <div className="keybinding-editor">
                          <label>
                            <span>Key combinations</span>
                            <input
                              aria-label={`Keys for ${item.label}`}
                              value={draft}
                              placeholder="Ctrl+Alt+K"
                              onChange={(event) => {
                                setDraft(event.target.value);
                                setError("");
                              }}
                            />
                          </label>
                          <div className="keybinding-editor-actions">
                            <button
                              type="button"
                              className="ghost"
                              disabled={item.id === "terminal.link"}
                              aria-pressed={recording}
                              onClick={() => {
                                setRecording(!recording);
                                setError("");
                              }}
                            >
                              {recording
                                ? "Press keys (Esc cancels)"
                                : "Record"}
                            </button>
                            <button
                              type="button"
                              ref={saveRef}
                              onClick={() =>
                                attempt(() => {
                                  const keys = validateShortcutKeys(
                                    item.id,
                                    draft.trim() ? draft.split(";") : [],
                                  );
                                  const conflicts = shortcutConflicts(
                                    item.id,
                                    keys,
                                    preset.bindings,
                                  );
                                  if (conflicts.length)
                                    throw new Error(
                                      `Already used by: ${conflicts.map((id) => SHORTCUT_CATALOG.find((entry) => entry.id === id)?.label ?? id).join(", ")}. Change that shortcut first.`,
                                    );
                                  updateShortcut(item.id, keys);
                                  clearEditor();
                                })
                              }
                            >
                              Save binding
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() =>
                                attempt(() => {
                                  updateShortcut(item.id, []);
                                  clearEditor();
                                })
                              }
                            >
                              Unassign
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() =>
                                setDraft(
                                  defaultShortcutBindings(preset.base)[
                                    item.id
                                  ].join("; "),
                                )
                              }
                            >
                              Default
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={clearEditor}
                            >
                              Cancel
                            </button>
                          </div>
                          <p className="muted">
                            Separate alternatives with a semicolon. Letter and
                            number shortcuts use physical keys.{" "}
                            {item.id === "terminal.link"
                              ? "For links, enter a modifier plus Click."
                              : "Escape and ordinary dialog navigation stay available."}
                          </p>
                          {shortcutWarning(draft.split(";")) ? (
                            <p className="muted">
                              {shortcutWarning(draft.split(";"))}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
              </dl>
            </section>
          ))}
          {visible.length === 0 ? (
            <p className="muted">No matching shortcuts.</p>
          ) : null}
          {!search ? (
            <section className="shortcut-section keybinding-reference">
              <h3>Navigation & native controls</h3>
              <p>
                Escape closes menus and dialogs or dismisses notifications. Tab
                moves focus; arrow keys and Enter navigate lists. In the recent
                pane switcher, use Up/Down and Enter, or release the modifier
                used to open it.
              </p>
              <p>
                Terminal copy uses the selected text; Ctrl+C remains terminal
                input unless reassigned. Page Up/Down follows the application or
                shell, while half-page shortcuts scroll terminal history. Native
                text editing and editor search navigation follow those
                applications. Browser and operating system shortcuts may take
                precedence over configured bindings.
              </p>
              <p>
                Touch controls have their own editor: Behavior & automation →
                Mobile terminal shortcuts configures the two shortcut rows and
                four side buttons.
              </p>
            </section>
          ) : null}
        </div>
        <div className="modal-actions">
          <span className="muted">
            Presets are saved in this browser. Export to use them elsewhere.
          </span>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
