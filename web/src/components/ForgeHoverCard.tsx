import { ExternalLink } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  type ForgeStatus,
  forgeKind,
  forgeRefLabel,
} from "../../../shared/forge";
import { formatUiDateTime } from "../uiLocale";
import { PipelineIcon, pipelineLabel } from "./ForgeChip";

const WIDTH = 340;
const EDGE = 12;

/**
 * More of a request than its chip shows: title, author, branches, the
 * pipeline's failed jobs and when it last changed. Every field is text;
 * the only link is the request's own page (and its pipelines tab).
 */
export function ForgeHoverCard({
  status,
  anchor,
  onEnter,
  onLeave,
}: {
  status: ForgeStatus;
  anchor: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.bottom + 6);
  const left = Math.max(
    EDGE,
    Math.min(anchor.left, window.innerWidth - WIDTH - EDGE),
  );
  // Above the chip when there is no room under it.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    if (anchor.bottom + 6 + height > window.innerHeight - EDGE)
      setTop(Math.max(EDGE, anchor.top - 6 - height));
  }, [anchor]);
  const request = status.state === "ready" ? status.request : undefined;
  const kind = forgeKind(status.ref.provider);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover keeps it open
    <div
      ref={ref}
      className="forge-card"
      role="tooltip"
      style={{ top, left, width: WIDTH }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="forge-card-head">
        <span>
          {kind}{" "}
          {forgeRefLabel({
            ...status.ref,
            project: request?.project ?? status.ref.project,
          })}
        </span>
        <small>{status.ref.host}</small>
      </div>
      {request ? (
        <>
          <p className="forge-card-title">{request.title}</p>
          <dl>
            <dt>State</dt>
            <dd>
              {request.draft && request.state === "open"
                ? "Draft"
                : request.state[0]!.toUpperCase() + request.state.slice(1)}
            </dd>
            {request.author ? (
              <>
                <dt>Author</dt>
                <dd>@{request.author}</dd>
              </>
            ) : null}
            <dt>Branches</dt>
            <dd className="forge-card-branches">
              {request.sourceBranch} → {request.targetBranch}
            </dd>
            <dt>Pipeline</dt>
            <dd>
              {request.pipeline ? (
                <>
                  <PipelineIcon status={request.pipeline.status} />{" "}
                  {pipelineLabel(request.pipeline.status).replace(
                    "Pipeline ",
                    "",
                  )}
                </>
              ) : (
                "none reported"
              )}
            </dd>
            {request.approvals ? (
              <>
                <dt>Approvals</dt>
                <dd>
                  {request.approvals.count}
                  {request.approvals.approved === true
                    ? " · approved"
                    : request.approvals.approved === false
                      ? " · not approved yet"
                      : ""}
                </dd>
              </>
            ) : null}
            {request.unresolved !== null ? (
              <>
                <dt>Threads</dt>
                <dd>
                  {request.unresolved
                    ? `${request.unresolved} unresolved`
                    : "all resolved"}
                </dd>
              </>
            ) : null}
            {request.updatedAt ? (
              <>
                <dt>Updated</dt>
                <dd>{formatUiDateTime(request.updatedAt)}</dd>
              </>
            ) : null}
          </dl>
          {request.pipeline?.failed.length ? (
            <div className="forge-card-jobs">
              <span>
                Failed {status.ref.provider === "gitlab" ? "jobs" : "checks"}
              </span>
              <ul>
                {request.pipeline.failed.map((job, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                  <li key={index}>
                    {job.stage ? <small>{job.stage}</small> : null}
                    {job.name}
                    {job.allowFailure ? <small> (allowed)</small> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="forge-card-actions">
            <a href={request.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={12} aria-hidden /> Open
            </a>
            {request.pipeline && status.ref.provider === "gitlab" ? (
              <a
                href={`${request.url}/pipelines`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Pipelines
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <p className="forge-card-note">
          {status.message ?? "Nothing to show."}
        </p>
      )}
    </div>
  );
}
