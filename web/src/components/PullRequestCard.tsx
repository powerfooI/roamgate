import { useEffect, useRef, useState } from "react";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import type { ConnectionClient } from "../api";
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
  const pr = current?.state === "ready" ? current.request : undefined;
  const provider =
    current?.provider === "github"
      ? "GitHub"
      : current?.provider === "gitlab"
        ? "GitLab"
        : "PR/MR";
  const loading = !status && !error;
  const reset = () => {
    sequence.current++;
    setStatus(null);
    setError("");
    setFinishedAt("");
  };
  return (
    <details className="pull-request-card">
      <summary>
        {provider}
        {pr
          ? ` #${pr.number}: ${pr.title} (${pr.state}${pr.draft ? ", draft" : ""})`
          : " status"}
      </summary>
      <div className="pull-request-card-content">
        <div className="pull-request-card-actions">
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              reset();
              setRefresh((value) => value + 1);
            }}
          >
            Refresh PR/MR
          </button>
          {pr ? (
            <a href={pr.url} target="_blank" rel="noopener noreferrer">
              Open on {provider}
            </a>
          ) : null}
        </div>
        <div role="status" aria-live="polite">
          {loading ? "Loading PR/MR status..." : error || current?.message}
          {!client.isCurrent()
            ? "Connection changed. Reopen Inspector to refresh."
            : null}
        </div>
        {current ? (
          <div className="pull-request-card-identity">
            {current.root} {current.branch ? `(${current.branch})` : ""}
          </div>
        ) : null}
        {current ? (
          <PullRequestSelectors
            current={current}
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
        ) : null}
        {pr ? (
          <>
            <div>
              #{pr.number} {pr.title}
            </div>
            <div>
              {pr.state}
              {pr.draft ? " / Draft" : ""} &middot; Author: {pr.author}
            </div>
            <div>
              {pr.source} &rarr; {pr.target}
            </div>
            <div>
              {provider === "GitHub" ? "Checks" : "Pipeline"}:{" "}
              {current?.ci ?? "Unavailable"}
            </div>
            <div>
              {provider === "GitHub" ? "Review decision" : "Approvals"}:{" "}
              {current?.review ?? "Unavailable"}
            </div>
          </>
        ) : null}
        {finishedAt ? (
          <div className="pull-request-card-time">
            Last refresh:{" "}
            <time dateTime={finishedAt}>
              {new Date(finishedAt).toLocaleString()}
            </time>
          </div>
        ) : null}
      </div>
    </details>
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
          <select
            value={current.remote ?? ""}
            onChange={(event) => {
              onRemoteChange(event.target.value);
            }}
          >
            <option value="" disabled>
              Select remote
            </option>
            {current.remotes.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}: {item.host}/{item.repository}
              </option>
            ))}
          </select>
        </label>
      ) : current?.remotes[0] ? (
        <div>
          {current.remotes[0].host}/{current.remotes[0].repository}
        </div>
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
