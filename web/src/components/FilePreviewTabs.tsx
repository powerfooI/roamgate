import { File, X } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import type { ResourceFileTabs } from "../workspaceResource";
import "./FilePreviewTabs.css";

export function FilePreviewTabs({
  tabs,
  panelId,
  onSelect,
  onClose,
  onEmptyFocus,
}: {
  tabs: ResourceFileTabs;
  panelId: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onEmptyFocus: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.activePath]);
  const focus = (path: string) => {
    const index = tabs.paths.indexOf(path);
    const buttons =
      listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    buttons?.[index]?.focus();
  };
  const close = (path: string, restoreFocus: boolean) => {
    const index = tabs.paths.indexOf(path);
    const next =
      path === tabs.activePath
        ? (tabs.paths[index + 1] ?? tabs.paths[index - 1])
        : tabs.activePath;
    onClose(path);
    if (restoreFocus) {
      // Focus before React removes this tab; a neighboring DOM node survives.
      if (next) focus(next);
      else requestAnimationFrame(onEmptyFocus);
    }
  };
  if (!tabs.paths.length) return null;
  return (
    <div
      className="file-preview-tabs"
      role="tablist"
      aria-label="Open files"
      ref={listRef}
    >
      {tabs.paths.map((path, index) => {
        const name = path.split("/").pop() || path;
        const duplicateName = tabs.paths.some(
          (other) => other !== path && other.split("/").pop() === name,
        );
        const parent = path.slice(0, -(name.length + 1));
        const active = path === tabs.activePath;
        return (
          <div
            className={`file-preview-tab ${active ? "is-active" : ""}`}
            key={path}
            role="presentation"
            data-file-preview-tab=""
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              close(path, event.currentTarget.contains(document.activeElement));
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
          >
            <button
              type="button"
              role="tab"
              id={`${id}-${index}`}
              aria-controls={panelId}
              aria-selected={active}
              aria-label={path}
              title={path}
              tabIndex={active ? 0 : -1}
              className="file-preview-tab-select"
              onClick={() => onSelect(path)}
              onKeyDown={(event) => {
                const nextIndex =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.paths.length
                    : event.key === "ArrowLeft"
                      ? (index - 1 + tabs.paths.length) % tabs.paths.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.paths.length - 1
                          : undefined;
                if (nextIndex !== undefined) {
                  event.preventDefault();
                  event.stopPropagation();
                  const next = tabs.paths[nextIndex]!;
                  onSelect(next);
                  focus(next);
                } else if (event.key === "Delete") {
                  event.preventDefault();
                  event.stopPropagation();
                  close(path, true);
                }
              }}
            >
              <File size={13} aria-hidden="true" />
              <span className="file-preview-tab-name">{name}</span>
              {duplicateName && parent ? (
                <span className="file-preview-tab-parent">{parent}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="file-preview-tab-close"
              aria-label={`Close ${path}`}
              title="Close file (Delete on tab)"
              tabIndex={active ? 0 : -1}
              onClick={(event) =>
                close(path, event.currentTarget === document.activeElement)
              }
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
