import { ArrowLeft, GitCommitHorizontal, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionClient } from "../api";
import type { FilePreview, GitDiffEntry, GitDiffFile } from "../types";
import { gitDiffCode } from "../gitDiffStatus";
import { DiffContentView } from "./DiffContentView";
import "./GitCommitHistory.css";

type CommitItem = {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  authored_at: string;
};
type CommitDetail = {
  sha: string;
  parents: string[];
  base: string | null;
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  entries: GitDiffEntry[];
  shallow_boundary?: boolean;
};
type CommitPage = {
  head: string | null;
  commits: CommitItem[];
  has_more: boolean;
  shallow: boolean;
};
type HistoricalPreview = Pick<
  FilePreview,
  "path" | "text" | "binary" | "image_data_url" | "truncated" | "size"
>;

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function GitCommitHistory({
  client,
  workspaceId,
  resourceKey,
  compact,
  active,
}: {
  client: ConnectionClient;
  workspaceId: string;
  resourceKey: string;
  compact: boolean;
  active: boolean;
}) {
  const [page, setPage] = useState<CommitPage | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, GitDiffFile>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<HistoricalPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const loadedDetailRef = useRef<CommitDetail | null>(null);

  useEffect(() => {
    if (!active || page) return;
    let current = true;
    setLoading(true);
    setError(null);
    setPage(null);
    setSelectedSha(null);
    setDetail(null);
    loadedDetailRef.current = null;
    setMobileDetail(false);
    void (
      client.call("git.commits", {
        workspace_id: workspaceId,
      }) as Promise<CommitPage>
    )
      .then((result) => {
        if (!current || !client.isCurrent()) return;
        setPage(result);
        setSelectedSha(result.commits[0]?.sha ?? null);
      })
      .catch((cause) => {
        if (current) setError((cause as Error).message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, client, workspaceId, refresh, page]);

  const loadMore = async () => {
    if (!page?.head || !page.has_more || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = (await client.call("git.commits", {
        workspace_id: workspaceId,
        head: page.head,
        offset: page.commits.length,
      })) as CommitPage;
      if (client.isCurrent())
        setPage((current) =>
          current?.head === page.head &&
          current.commits.length === page.commits.length
            ? { ...next, commits: [...current.commits, ...next.commits] }
            : current,
        );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!selectedSha || !active || loadedDetailRef.current?.sha === selectedSha)
      return;
    let current = true;
    loadedDetailRef.current = null;
    setDetail(null);
    setSelectedPath(null);
    setPreviewPath(null);
    setFiles({});
    setFileErrors({});
    setDetailLoading(true);
    setDetailError(null);
    void (
      client.call("git.commit", {
        workspace_id: workspaceId,
        sha: selectedSha,
      }) as Promise<CommitDetail>
    )
      .then((result) => {
        if (!current || !client.isCurrent()) return;
        loadedDetailRef.current = result;
        setDetail(result);
        setSelectedPath(result.entries[0]?.path ?? null);
      })
      .catch((cause) => {
        if (current) setDetailError((cause as Error).message);
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, client, selectedSha, workspaceId]);

  const entry =
    detail?.entries.find((item) => item.path === selectedPath) ?? null;
  const fileKey = entry ? `branch:${entry.path}` : "";
  const messageBody = detail?.message
    .split("\n")
    .slice(1)
    .join("\n")
    .replace(/^\n/, "");
  useEffect(() => {
    if (!detail || !entry || !active || files[fileKey] || fileErrors[fileKey])
      return;
    let current = true;
    setFileLoading(true);
    void (
      client.call("git.commit_file", {
        workspace_id: workspaceId,
        sha: detail.sha,
        base: detail.base,
        path: entry.path,
        old_path: entry.old_path,
      }) as Promise<GitDiffFile>
    )
      .then((result) => {
        if (current && client.isCurrent())
          setFiles((prev) => ({ ...prev, [fileKey]: result }));
      })
      .catch((cause) => {
        if (current)
          setFileErrors((prev) => ({
            ...prev,
            [fileKey]: (cause as Error).message,
          }));
      })
      .finally(() => {
        if (current) setFileLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, client, detail, entry, fileErrors, fileKey, files, workspaceId]);

  const openPreview = (target: GitDiffEntry) => {
    setSelectedPath(target.path);
    setPreviewPath(target.path);
    setMobileDetail(true);
  };
  useEffect(() => {
    if (!detail || !previewPath || !active) return;
    const target = detail.entries.find((item) => item.path === previewPath);
    if (!target) return;
    let current = true;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    const before = target.status === "deleted";
    void (
      client.call("git.commit_preview", {
        workspace_id: workspaceId,
        sha: before ? detail.base : detail.sha,
        path: before ? (target.old_path ?? target.path) : target.path,
      }) as Promise<HistoricalPreview>
    )
      .then((result) => {
        if (current && client.isCurrent()) setPreview(result);
      })
      .catch((cause) => {
        if (current) setPreviewError((cause as Error).message);
      })
      .finally(() => {
        if (current) setPreviewLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, client, detail, previewPath, workspaceId]);

  const loadImagePreview = useCallback(
    async (path: string) => {
      const target = detail?.entries.find((item) => item.path === path);
      const before = target?.status === "deleted";
      return (await client.call("git.commit_preview", {
        workspace_id: workspaceId,
        sha: before ? detail?.base : detail?.sha,
        path: before ? (target?.old_path ?? path) : path,
      })) as FilePreview;
    },
    [client, detail, workspaceId],
  );

  const selectCommit = (sha: string) => {
    setSelectedSha(sha);
    setMobileDetail(true);
  };

  return (
    <div
      className={`git-commit-history ${compact ? "is-compact" : ""} ${mobileDetail ? "has-detail" : ""}`}
    >
      <div className="git-commit-navigation">
        <div className="git-commit-navigation-head">
          <span>Commit history</span>
          <button
            type="button"
            title="Refresh commits"
            aria-label="Refresh commits"
            onClick={() => {
              setPage(null);
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {loading ? (
          <div className="git-commit-state">
            <span className="file-loading-spinner" /> Loading commits
          </div>
        ) : null}
        {error ? (
          <div className="git-commit-state is-error" role="alert">
            {error}
          </div>
        ) : null}
        {page?.shallow ? (
          <div className="git-commit-shallow">
            Shallow clone · older commits may be unavailable
          </div>
        ) : null}
        {!loading && !error && page?.commits.length === 0 ? (
          <div className="git-commit-state">No commits yet.</div>
        ) : null}
        <div className="git-commit-list">
          {page?.commits.map((item) => (
            <button
              key={item.sha}
              type="button"
              className={`git-commit-row ${selectedSha === item.sha ? "is-selected" : ""}`}
              onClick={() => selectCommit(item.sha)}
              aria-pressed={selectedSha === item.sha}
            >
              <span className="git-commit-subject">{item.subject}</span>
              <span className="git-commit-subline">
                <code>{item.short_sha}</code>
                <span>{item.author}</span>
                <time dateTime={item.authored_at}>
                  {date(item.authored_at)}
                </time>
              </span>
            </button>
          ))}
        </div>
        {page?.has_more ? (
          <button
            type="button"
            className="git-commit-more"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more commits"}
          </button>
        ) : null}
      </div>
      <div className="git-commit-detail">
        {compact && mobileDetail ? (
          <button
            type="button"
            className="git-commit-back"
            onClick={() => {
              setMobileDetail(false);
              setPreviewPath(null);
            }}
          >
            <ArrowLeft size={14} /> Commits
          </button>
        ) : null}
        {detailLoading ? (
          <div className="git-commit-state">
            <span className="file-loading-spinner" /> Loading commit
          </div>
        ) : null}
        {detailError ? (
          <div className="git-commit-state is-error" role="alert">
            {detailError}
          </div>
        ) : null}
        {!selectedSha && !loading ? (
          <div className="git-commit-state">
            Select a commit to inspect its changes.
          </div>
        ) : null}
        {detail && detail.sha === selectedSha ? (
          <>
            <div className="git-commit-meta">
              <div className="git-commit-meta-title">
                <GitCommitHorizontal size={16} />
                <strong>{detail.message.split("\n")[0]}</strong>
              </div>
              {messageBody ? (
                <pre className="git-commit-message">{messageBody}</pre>
              ) : null}
              <dl>
                <dt>Commit</dt>
                <dd>
                  <code>{detail.sha}</code>
                </dd>
                <dt>Author</dt>
                <dd>
                  {detail.author.name} &lt;{detail.author.email}&gt;{" "}
                  <time dateTime={detail.author.date}>
                    {date(detail.author.date)}
                  </time>
                </dd>
                <dt>Committer</dt>
                <dd>
                  {detail.committer.name} &lt;{detail.committer.email}&gt;{" "}
                  <time dateTime={detail.committer.date}>
                    {date(detail.committer.date)}
                  </time>
                </dd>
                <dt>{detail.parents.length > 1 ? "First parent" : "Parent"}</dt>
                <dd>
                  {detail.base ? (
                    <code>{detail.base}</code>
                  ) : (
                    "Empty tree (root commit)"
                  )}
                </dd>
                {detail.parents.length > 1 ? (
                  <>
                    <dt>Other parents</dt>
                    <dd>
                      {detail.parents.slice(1).map((parent) => (
                        <code key={parent}>{parent} </code>
                      ))}
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>
            <div className="git-commit-files-head">
              <strong>
                {detail.entries.length} changed{" "}
                {detail.entries.length === 1 ? "file" : "files"}
              </strong>
              {detail.parents.length > 1 ? (
                <span>Compared with first parent</span>
              ) : null}
            </div>
            {detail.shallow_boundary ? (
              <div className="git-commit-state">
                This commit's parent is outside the shallow history; its changes
                are unavailable.
              </div>
            ) : null}
            {detail.entries.length ? (
              <div className="git-commit-files">
                {detail.entries.map((item) => (
                  <div
                    key={item.path}
                    className={`git-commit-file ${selectedPath === item.path ? "is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPath(item.path);
                        setPreviewPath(null);
                      }}
                      aria-pressed={selectedPath === item.path}
                      title={item.path}
                    >
                      <span
                        className={`git-status-code git-status-${gitDiffCode(item).toLowerCase()}`}
                      >
                        {gitDiffCode(item)}
                      </span>
                      <span className="git-commit-file-name">
                        {item.path}
                        {item.old_path ? (
                          <small>from {item.old_path}</small>
                        ) : null}
                      </span>
                      <span className="git-commit-file-status">
                        {item.status}
                      </span>
                      <span className="git-commit-file-count">
                        {item.binary ? (
                          "Binary"
                        ) : item.additions === undefined ? (
                          ""
                        ) : (
                          <>
                            <em>+{item.additions}</em> <i>−{item.deletions}</i>
                          </>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="git-commit-preview-button"
                      onClick={() => openPreview(item)}
                      aria-label={`Preview ${item.path} at this commit`}
                    >
                      Preview
                    </button>
                  </div>
                ))}
              </div>
            ) : detail.shallow_boundary ? null : (
              <div className="git-commit-state">
                This commit has no changes against its first parent.
              </div>
            )}
            <div className="git-commit-content">
              {previewPath ? (
                <section
                  className="git-commit-preview"
                  aria-label="Historical file preview"
                >
                  <div className="git-commit-preview-head">
                    <strong>{previewPath}</strong>
                    <button type="button" onClick={() => setPreviewPath(null)}>
                      Back to diff
                    </button>
                  </div>
                  {previewLoading ? (
                    <div className="git-commit-state">
                      <span className="file-loading-spinner" /> Loading
                      historical file
                    </div>
                  ) : null}
                  {previewError ? (
                    <div className="git-commit-state is-error" role="alert">
                      {previewError}
                    </div>
                  ) : null}
                  {preview?.truncated ? (
                    <div className="git-commit-state">
                      File is too large to preview.
                    </div>
                  ) : null}
                  {preview?.image_data_url ? (
                    <img src={preview.image_data_url} alt={previewPath} />
                  ) : null}
                  {preview && !preview.truncated && preview.text !== null ? (
                    <pre>{preview.text}</pre>
                  ) : null}
                  {preview &&
                  !preview.truncated &&
                  preview.binary &&
                  !preview.image_data_url ? (
                    <div className="git-commit-state">
                      Binary file preview unavailable.
                    </div>
                  ) : null}
                </section>
              ) : (
                <DiffContentView
                  key={detail.sha}
                  entry={entry}
                  file={entry ? (files[fileKey] ?? null) : null}
                  loading={fileLoading}
                  error={entry ? (fileErrors[fileKey] ?? null) : null}
                  entries={detail.entries}
                  files={files}
                  fileErrors={fileErrors}
                  resourceKey={`${resourceKey}:commit:${detail.sha}`}
                  connectionClient={client}
                  mobile={compact}
                  onSelectFile={(target) => {
                    setFileErrors((prev) => {
                      const next = { ...prev };
                      delete next[`branch:${target.path}`];
                      return next;
                    });
                    setSelectedPath(target.path);
                  }}
                  onOpenFile={openPreview}
                  openFileLabel="Preview at commit"
                  loadImagePreview={loadImagePreview}
                />
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
