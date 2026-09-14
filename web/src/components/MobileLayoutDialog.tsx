import { useEffect, useRef } from "react";
import { CloseButton } from "./CloseButton";
import { ThemedSelect } from "./ThemedSelect";
import { focusDialogElement } from "./dialogFocus";
import {
  type LayoutMode,
  MOBILE_BREAKPOINT_MAX,
  MOBILE_BREAKPOINT_MIN,
  type SidebarOrder,
  updateLayoutPreferences,
  useLayoutPreferences,
} from "../layoutPreferences";

export function MobileLayoutDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) return focusDialogElement(dialogRef.current);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open popover (themed select) consumes Escape to close itself.
      if (document.querySelector(".popover-content")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);
  const { preferences, mobile, urlOverride } = useLayoutPreferences();
  if (!open) return null;
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
        className="modal mobile-layout-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Layout Preferences"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
            ),
          );
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
            <h2>Layout Preferences</h2>
            <p>Choose display mode, mobile breakpoint, and sidebar order.</p>
          </div>
          <CloseButton label="Close Layout Preferences" onClick={onClose} />
        </div>
        <div className="layout-preferences">
          <label>
            <span>Display mode</span>
            <ThemedSelect
              aria-label="Display mode"
              value={urlOverride ?? preferences.mode}
              options={[
                { value: "auto", label: "Automatic" },
                { value: "mobile", label: "Mobile" },
                { value: "desktop", label: "Desktop" },
              ]}
              onChange={(mode) =>
                updateLayoutPreferences({ mode: mode as LayoutMode })
              }
            />
          </label>
          <p className="muted">
            Using {mobile ? "mobile" : "desktop"} layout
            {urlOverride ? " (URL override)" : ""}. Bookmark with ?layout=mobile
            or ?layout=desktop to force a layout.
          </p>
          <label>
            <span>Mobile up to (px)</span>
            <input
              key={preferences.mobileBreakpoint}
              type="number"
              min={MOBILE_BREAKPOINT_MIN}
              max={MOBILE_BREAKPOINT_MAX}
              step={1}
              defaultValue={preferences.mobileBreakpoint}
              onBlur={(event) => {
                if (
                  event.currentTarget.value &&
                  event.currentTarget.validity.valid
                ) {
                  updateLayoutPreferences({
                    mobileBreakpoint: event.currentTarget.valueAsNumber,
                  });
                } else {
                  event.currentTarget.value = String(
                    preferences.mobileBreakpoint,
                  );
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
          {(["mobile", "desktop"] as const).map((view) => (
            <label key={view}>
              <span>{view === "mobile" ? "Mobile" : "Desktop"} sidebar</span>
              <ThemedSelect
                aria-label={`${view === "mobile" ? "Mobile" : "Desktop"} sidebar`}
                value={preferences[`${view}SidebarOrder`]}
                options={[
                  { value: "agents-first", label: "Agents on top" },
                  { value: "workspaces-first", label: "Workspaces on top" },
                ]}
                onChange={(order) =>
                  updateLayoutPreferences({
                    [`${view}SidebarOrder`]: order as SidebarOrder,
                  })
                }
              />
            </label>
          ))}
          <p className="muted">
            Sidebar order applies when Agents is set to Separate.
          </p>
        </div>
        <div className="modal-actions">
          <span className="muted">Changes are saved in this browser.</span>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
