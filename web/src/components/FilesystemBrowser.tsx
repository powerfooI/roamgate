import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  Folder,
  RefreshCw,
  Search,
} from "lucide-react";
import type { ConnectionClient } from "../api";
import type { FileExplorerEntry, FileExplorerList } from "../types";
import { createFileSearchMatcher } from "../fileSearch";
import { parentFilesystemPath } from "../filesystemPaths";
import "./FilesystemBrowser.css";

/** An opt-in, read-only browser with no persisted directory or mode state. */
export function FilesystemBrowser({
  client,
  workspaceId,
  initialPath,
  showHidden,
  onShowHiddenChange,
  activePath,
  onSelect,
  onPinFile,
  onMenu,
  onExit,
}: {
  client: ConnectionClient;
  workspaceId: string;
  initialPath: string;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  activePath?: string;
  onSelect: (entry: FileExplorerEntry) => void;
  onPinFile?: (path: string) => void;
  onMenu: (entry: FileExplorerEntry, x: number, y: number) => void;
  onExit: () => void;
}) {
  const [directory, setDirectory] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<FileExplorerList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setList(null);
    void client
      .call("file.list", {
        workspace_id: workspaceId,
        path: directory,
        show_hidden: showHidden,
        scope: "filesystem",
      })
      .then((result: FileExplorerList & { scope?: string }) => {
        if (cancelled || !client.isCurrent()) return;
        if (result.scope !== "filesystem") {
          throw new Error(
            "Filesystem browsing requires an updated Studio bridge.",
          );
        }
        setList(result);
        // Do not replace a directory the user started typing while loading.
        setPathInput((draft) => (draft === directory ? result.root : draft));
      })
      .catch((reason: Error) => {
        if (!cancelled && client.isCurrent()) setError(reason.message);
      })
      .finally(() => {
        if (!cancelled && client.isCurrent()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, directory, showHidden, refresh]);

  const entries = useMemo(
    () => (list?.entries ?? []).filter(createFileSearchMatcher(search)),
    [list, search],
  );
  const currentPath = list?.root ?? directory;
  const parent = parentFilesystemPath(currentPath);
  const navigate = (path: string) => {
    setSearch("");
    setPathInput(path);
    setDirectory(path);
    setRefresh((value) => value + 1);
  };
  const openEntry = (entry: FileExplorerEntry) => {
    if (entry.type === "directory") navigate(entry.path);
    else onSelect(entry);
  };

  return (
    <div
      className="filesystem-browser"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="filesystem-mode">
        <span>
          Filesystem <small>(read only)</small>
        </span>
        <button type="button" className="ghost" onClick={onExit}>
          <ArrowLeft size={14} /> Workspace only
        </button>
      </div>
      <form
        className="filesystem-location"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(pathInput.trim());
        }}
      >
        <button
          type="button"
          className="ghost file-action"
          title="Parent directory"
          aria-label="Parent directory"
          disabled={!currentPath || parent === currentPath.replace(/\\/g, "/")}
          onClick={() => navigate(parent)}
        >
          <ArrowUp size={15} />
        </button>
        <input
          aria-label="Directory path"
          title={currentPath}
          value={pathInput}
          placeholder="Absolute directory on the connected host"
          spellCheck={false}
          onChange={(event) => setPathInput(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="ghost file-action"
          title="Go to directory"
          aria-label="Go to directory"
          disabled={!pathInput.trim()}
        >
          <ArrowRight size={15} />
        </button>
      </form>
      <div className="file-explorer-toolbar">
        <label className="file-search">
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search loaded files"
            aria-label="Search loaded files"
            maxLength={512}
            title="Search loaded names or paths. Globs: r*md, ?.txt, **/*.md, *.{md,txt}"
          />
        </label>
        <button
          type="button"
          className="file-hidden-toggle"
          aria-pressed={showHidden}
          title="Show hidden files"
          onClick={() => onShowHiddenChange(!showHidden)}
        >
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          Hidden
        </button>
        <span className="file-toolbar-end">
          <button
            type="button"
            className="file-toolbar-icon"
            title="Refresh"
            aria-label="Refresh files"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} className={loading ? "is-spinning" : ""} />
          </button>
        </span>
      </div>
      {error ? (
        <p className="modal-error" role="alert">
          {error}
        </p>
      ) : null}
      {list?.truncated ? (
        <p className="modal-error">
          This directory is truncated at 1000 entries.
        </p>
      ) : null}
      <div
        className="file-tree"
        role="list"
        aria-label="Filesystem entries"
        aria-busy={loading}
      >
        {loading ? (
          <div className="file-row file-row-muted" role="status">
            Loading directory...
          </div>
        ) : null}
        {!loading && !error && !entries.length ? (
          <div className="file-row file-row-muted">
            {search ? "No loaded files match." : "Empty"}
          </div>
        ) : null}
        {entries.map((entry) => (
          <div
            className="filesystem-entry"
            role="listitem"
            key={entry.path}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(entry, event.clientX, event.clientY);
            }}
          >
            <button
              type="button"
              className={`file-row ${entry.path === activePath ? "is-selected" : ""}`}
              data-file-path={entry.path}
              title={entry.path}
              onClick={() => openEntry(entry)}
              onDoubleClick={() => {
                if (entry.type !== "directory") onPinFile?.(entry.path);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" && parent !== currentPath) {
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(parent);
                  return;
                }
                if (event.key === "ArrowRight" && entry.type === "directory") {
                  event.preventDefault();
                  event.stopPropagation();
                  openEntry(entry);
                  return;
                }
                if (
                  !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                const rows = Array.from(
                  event.currentTarget
                    .closest("[role=list]")
                    ?.querySelectorAll<HTMLButtonElement>(
                      "button[data-file-path]",
                    ) ?? [],
                );
                const index = rows.indexOf(event.currentTarget);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? rows.length - 1
                      : index + (event.key === "ArrowDown" ? 1 : -1);
                rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
              }}
            >
              {entry.type === "directory" ? (
                <Folder size={15} />
              ) : (
                <File size={15} />
              )}
              <span className="file-name">{entry.name}</span>
            </button>
            <button
              type="button"
              className="ghost file-action"
              aria-label={`Actions for ${entry.name}`}
              title={`Actions for ${entry.name}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(entry, rect.right, rect.bottom);
              }}
            >
              <Ellipsis size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
