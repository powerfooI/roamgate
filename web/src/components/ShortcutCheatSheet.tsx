import { Fragment, useEffect, useRef, useState } from "react";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import { activeTerminalInput } from "../activeTerminalInput";
import { SHORTCUT_PLATFORMS } from "../shortcutBindings";
import { shortcutCheatSheet } from "../shortcutCheatSheet";
import {
  shortcutMatches,
  useShortcutPreferences,
} from "../shortcutPreferences";
import "./ShortcutCheatSheet.css";

/** Read-only overview of the active preset; editing stays in Configuration. */
export function ShortcutCheatSheet({ onClose }: { onClose: () => void }) {
  const { preferences, preset, platform } = useShortcutPreferences();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const groups = shortcutCheatSheet(preset.bindings, platform, search);

  useEffect(() => {
    const previous = document.activeElement;
    const cancelFocus = focusDialogElement(searchRef.current);
    return () => {
      cancelFocus();
      // Opening from the menu unmounts the trigger; return to the terminal.
      const target =
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous !== document.body
          ? previous
          : activeTerminalInput(document);
      target?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape" && !shortcutMatches(event, "shortcuts.show"))
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal shortcut-cheatsheet"
        role="dialog"
        aria-modal="true"
        aria-label="Shortcut cheat sheet"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "button, input",
            ),
          ];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
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
            <p>
              {preferences.active === "auto"
                ? `Automatic (${SHORTCUT_PLATFORMS[platform]})`
                : preset.name}
            </p>
          </div>
          <input
            ref={searchRef}
            type="search"
            className="shortcut-cheatsheet-search"
            aria-label="Filter shortcuts"
            placeholder="Filter shortcuts..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <CloseButton label="Close shortcut cheat sheet" onClick={onClose} />
        </div>
        <div className="shortcut-cheatsheet-body">
          {groups.map(({ group, rows }) => (
            <section key={group} className="shortcut-cheatsheet-group">
              <h3>{group}</h3>
              <dl>
                {rows.map((row) => (
                  <div key={row.key} className="shortcut-cheatsheet-row">
                    <dt>{row.label}</dt>
                    <dd>
                      {row.combos.length === 0 ? (
                        <span className="shortcut-cheatsheet-unassigned">
                          Unassigned
                        </span>
                      ) : (
                        row.combos.map((caps, index) => (
                          <Fragment key={caps.join("+")}>
                            {index > 0 ? (
                              <span className="shortcut-cheatsheet-or">or</span>
                            ) : null}
                            <span className="shortcut-cheatsheet-combo">
                              {caps.map((cap, capIndex) => (
                                <kbd key={capIndex}>{cap}</kbd>
                              ))}
                            </span>
                          </Fragment>
                        ))
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {groups.length === 0 ? (
            <p className="shortcut-cheatsheet-empty">No matching shortcuts.</p>
          ) : null}
        </div>
        <p className="shortcut-cheatsheet-foot">
          Read-only. Change bindings in Configuration &gt; Behavior &gt;
          Keyboard shortcuts.
        </p>
      </div>
    </div>
  );
}
