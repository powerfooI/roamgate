import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import type { ConnectionClient } from "../api";
import { ThemedSelect } from "./ThemedSelect";
import "./PullRequestCard.css";

export function PullRequestCard({
  client,
  workspaceId,
  branch,
}: {
  client: ConnectionClient;
  workspaceId: string;
  branch?: string;
}) {
  const [remote, setRemote] = useState("");
  const [match, setMatch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<PullRequestStatus | null>(null);
  const [error, setError] = useState("");
  const [finishedAt, setFinishedAt] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    setStatus(null);
    setError("");
    setFinishedAt("");
    void client
      .call(
        "git.pull_request",
        {
          workspace_id: workspaceId,
          ...(branch ? { branch } : {}),
          ...(remote ? { remote } : {}),
          ...(match ? { match } : {}),
        },
        65_000,
      )
      .then((value: PullRequestStatus) => {
        if (sequence.current !== request || !client.isCurrent()) return;
        setStatus(value);
        setFinishedAt(value.refreshedAt);
      })
      .catch(() => {
        if (sequence.current !== request || !client.isCurrent()) return;
        setError("PR/MR status unavailable. Check the connection and refresh.");
        setFinishedAt(new Date().toISOString());
      });
    return () => {
      sequence.current = request + 1;
    };
  }, [client, workspaceId, branch, remote, match, refresh]);

  const current = client.isCurrent() ? status : null;
  const loading = !status && !error;
  const reset = () => {
    sequence.current++;
    setStatus(null);
    setError("");
    setFinishedAt("");
  };
  return (
    <PullRequestCardView
      current={current}
      loading={loading}
      error={
        client.isCurrent()
          ? error
          : "Connection changed. Reopen Inspector to refresh."
      }
      finishedAt={finishedAt}
      onRefresh={() => {
        reset();
        setRefresh((value) => value + 1);
      }}
      onRemoteChange={(value) => {
        reset();
        setRemote(value);
        setMatch("");
      }}
      onMatchChange={(value) => {
        reset();
        setMatch(value);
      }}
    />
  );
}

export function PullRequestCardView({
  current,
  loading,
  error,
  finishedAt,
  onRefresh,
  onRemoteChange,
  onMatchChange,
}: {
  current: PullRequestStatus | null;
  loading: boolean;
  error: string;
  finishedAt: string;
  onRefresh: () => void;
  onRemoteChange: (value: string) => void;
  onMatchChange: (value: string) => void;
}) {
  const pr = current?.state === "ready" ? current.request : undefined;
  const provider =
    current?.provider === "github"
      ? "GitHub"
      : current?.provider === "gitlab"
        ? "GitLab"
        : "PR/MR";
  const label = error
    ? "Status unavailable"
    : loading
      ? "Checking this branch..."
      : current
        ? {
            ready: "Request found",
            select_remote: "Choose a source remote",
            select_match: "Choose a request",
            unsupported: "Provider not configured",
            missing_cli: "CLI setup needed",
            unauthenticated: "Authentication needed",
            no_match: "No linked request",
            detached: "No branch selected",
            error: "Status unavailable",
          }[current.state]
        : "Status unavailable";
  const needsAttention =
    !!error ||
    ["error", "missing_cli", "unauthenticated"].includes(current?.state ?? "");
  const message = error || current?.message;
  return (
    <section
      className="pull-request-card"
      aria-label="Pull or merge request status"
      data-attention={needsAttention || undefined}
    >
      <details className="pull-request-card-disclosure">
        <summary className="pull-request-card-summary">
          <span className="pull-request-card-icon">
            <GitPullRequest size={17} aria-hidden="true" />
          </span>
          <span className="pull-request-card-heading">
            <span className="pull-request-card-eyebrow">
              {pr ? (
                <a
                  className="pull-request-card-link"
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${provider} #${pr.number} in a new tab`}
                  title={`Open on ${provider}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  {provider} #{pr.number}
                  <ArrowUpRight size={13} aria-hidden="true" />
                </a>
              ) : (
                `${provider} status`
              )}
            </span>
            <span
              className="pull-request-card-title"
              role="status"
              aria-live="polite"
            >
              {pr?.title ?? label}
            </span>
          </span>
          {pr ? (
            <span
              className="pull-request-card-badge"
              data-state={pr.draft ? "draft" : pr.state}
            >
              {pr.draft ? `Draft / ${pr.state}` : pr.state}
            </span>
          ) : null}
          <ChevronRight
            className="pull-request-card-chevron"
            size={14}
            aria-hidden="true"
          />
        </summary>
        <div className="pull-request-card-content">
          {current ? (
            <PullRequestSelectors
              current={current}
              onRemoteChange={onRemoteChange}
              onMatchChange={onMatchChange}
            />
          ) : null}
          {pr ? (
            <div className="pull-request-card-signals">
              <div
                className="pull-request-card-route"
                aria-label="Source and target branches"
              >
                <code>{pr.source}</code>
                <ArrowRight size={13} aria-hidden="true" />
                <code>{pr.target}</code>
              </div>
              <dl>
                <div>
                  <dt>
                    <CircleDot size={12} aria-hidden="true" />
                    {current?.provider === "github" ? "Checks" : "Pipeline"}
                  </dt>
                  <dd>{current?.ci ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>
                    <CircleDot size={12} aria-hidden="true" />
                    {current?.provider === "github"
                      ? "Review decision"
                      : "Approvals"}
                  </dt>
                  <dd>{current?.review ?? "Unavailable"}</dd>
                </div>
              </dl>
            </div>
          ) : null}
          {!loading || error ? (
            <details className="pull-request-card-context">
              <summary>
                <ChevronRight size={12} aria-hidden="true" />
                {message ? "Details & troubleshooting" : "Checkout details"}
              </summary>
              {message ? (
                <p className="pull-request-card-message">{message}</p>
              ) : null}
              <dl>
                {pr ? (
                  <div>
                    <dt>Author</dt>
                    <dd>{pr.author}</dd>
                  </div>
                ) : null}
                {current?.remotes.map((remote) => (
                  <div key={remote.name}>
                    <dt>Remote / {remote.name}</dt>
                    <dd>
                      {remote.host}/{remote.repository}
                    </dd>
                  </div>
                ))}
                {current ? (
                  <>
                    <div>
                      <dt>Checkout</dt>
                      <dd>
                        <code>{current.root}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Branch</dt>
                      <dd>
                        <code>{current.branch || "Detached HEAD"}</code>
                      </dd>
                    </div>
                  </>
                ) : null}
                {finishedAt ? (
                  <div>
                    <dt>Last refreshed</dt>
                    <dd>
                      <time dateTime={finishedAt}>
                        {new Date(finishedAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </details>
          ) : null}
        </div>
      </details>
      <button
        className="pull-request-card-refresh"
        type="button"
        title="Refresh PR/MR status"
        aria-label="Refresh PR/MR status"
        disabled={loading}
        onClick={onRefresh}
      >
        <RefreshCw size={14} aria-hidden="true" />
      </button>
    </section>
  );
}

export function PullRequestSelectors({
  current,
  onRemoteChange,
  onMatchChange,
}: {
  current: PullRequestStatus;
  onRemoteChange: (value: string) => void;
  onMatchChange: (value: string) => void;
}) {
  const pr = current.state === "ready" ? current.request : undefined;
  return (
    <>
      {current.remotes.length > 1 || current.state === "select_remote" ? (
        <label>
          Source remote
          <ThemedSelect
            className="pull-request-card-remote-select"
            aria-label="Source remote"
            value={current.remote ?? ""}
            placeholder="Select remote"
            options={current.remotes.map((item) => ({
              value: item.name,
              label: `${item.name}: ${item.host}/${item.repository}`,
            }))}
            onChange={onRemoteChange}
          />
        </label>
      ) : null}
      {current.matches &&
      (current.matches.length > 1 || current.state === "select_match") ? (
        <label>
          Matching request
          <select
            value={pr?.id ?? ""}
            onChange={(event) => {
              onMatchChange(event.target.value);
            }}
          >
            <option value="" disabled>
              Select PR/MR
            </option>
            {current.matches.map((item) => (
              <option key={item.id} value={item.id}>
                #{item.number}: {item.title} ({item.state})
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}
