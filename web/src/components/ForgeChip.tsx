import {
  CircleCheck,
  CircleMinus,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  MessageSquare,
  ThumbsUp,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ForgePipelineStatus,
  type ForgeProject,
  type ForgeRef,
  type ForgeStatus,
  forgeKind,
  forgeRefKey,
  forgeRefLabel,
  parseForgeUrl,
} from "../../../shared/forge";
import type { ConnectionClient } from "../api";
import { findForgeMentions, resolveForgeMention } from "../forgeRefs";
import {
  type ForgeSlots,
  ForgeSlotsContext,
  type ForgeSlotTarget,
} from "../forgeSlots";
import { type ForgeEntry, useForgeStatus } from "../forgeStore";
import { lazyWithReload } from "../lazyWithReload";
import "./ForgeChip.css";

const ForgeHoverCard = lazyWithReload("forge-hover-card", () =>
  import("./ForgeHoverCard").then((module) => ({
    default: module.ForgeHoverCard,
  })),
);

/** What a chat's chips need: where to ask, and what `!12` means there. */
export type ForgeChat = {
  client: ConnectionClient;
  /** The chat's workspace. */
  workspaceId?: string;
  defaultProject: ForgeProject | null;
};

const ForgeChatContext = createContext<ForgeChat | null>(null);

export function useForgeChat(): ForgeChat | null {
  return useContext(ForgeChatContext);
}

function sameProject(ref: ForgeRef, project: ForgeProject | null) {
  return (
    !!project &&
    project.provider === ref.provider &&
    project.host === ref.host &&
    project.project.toLowerCase() === ref.project.toLowerCase()
  );
}

/** Marks a sanitized chat message's references (see ForgeSlots). */
export function markForgeReferences(
  root: HTMLElement,
  defaultProject: ForgeProject | null,
  chip: (ref: ForgeRef, written: string, url?: string) => ReactNode,
  options: Parameters<ForgeSlots["mark"]>[1] = {},
): ReturnType<ForgeSlots["mark"]> {
  const scopes = root.hasAttribute("data-forge-scan")
    ? [root]
    : [...root.querySelectorAll<HTMLElement>("[data-forge-scan]")];
  const doc = root.ownerDocument;
  const changes: { original: Node; inserted: Node[] }[] = [];
  const targets: ForgeSlotTarget[] = [];
  // The slots drawn before, by reference: a redraw reuses them in order.
  const reusable = new Map<string, HTMLElement[]>();
  for (const target of options.reuse ?? []) {
    const known = reusable.get(target.key);
    if (known) known.push(target.element);
    else reusable.set(target.key, [target.element]);
  }
  const slot = (ref: ForgeRef, written: string, url?: string) => {
    const key = `${forgeRefKey(ref)}\u0000${written}\u0000${url ?? ""}`;
    let element = reusable.get(key)?.shift();
    if (!element) {
      element = doc.createElement("span");
      element.className = "forge-slot";
    }
    targets.push({ element, node: chip(ref, written, url), key });
    return element;
  };
  for (const scope of scopes) {
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const anchors = new Set<Element>();
    for (const node of nodes) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          "code, pre, kbd, samp, .forge-slot, .markdown-mermaid-slot, .mermaid-diagram",
        )
      )
        continue;
      const anchor = parent.closest("a");
      if (anchor) {
        // An autolinked request URL becomes its chip; a link the author
        // named stays theirs.
        if (anchors.has(anchor)) continue;
        anchors.add(anchor);
        const href = anchor.getAttribute("href") ?? "";
        const ref = parseForgeUrl(href);
        const label = (anchor.textContent ?? "").trim();
        if (!ref || (label !== href && label !== href.replace(/\/$/, "")))
          continue;
        const element = slot(ref, label, href);
        anchor.replaceWith(element);
        changes.push({ original: anchor, inserted: [element] });
        continue;
      }
      const text = node.data;
      const matches = findForgeMentions(text)
        .map((match) => ({
          match,
          ref: resolveForgeMention(match.mention, defaultProject),
        }))
        .filter((found) => found.ref);
      if (!matches.length) continue;
      const inserted: Node[] = [];
      let at = 0;
      for (const { match, ref } of matches) {
        if (match.start > at)
          inserted.push(doc.createTextNode(text.slice(at, match.start)));
        inserted.push(
          slot(
            ref!,
            match.text,
            match.mention.kind === "url" ? match.text : undefined,
          ),
        );
        at = match.end;
      }
      if (at < text.length) inserted.push(doc.createTextNode(text.slice(at)));
      node.replaceWith(...inserted);
      changes.push({ original: node, inserted });
    }
  }
  return {
    targets,
    restore() {
      for (const { original, inserted } of changes.reverse()) {
        const first = inserted[0];
        if (!first?.parentNode) continue;
        first.parentNode.insertBefore(original, first);
        for (const node of inserted) (node as ChildNode).remove();
      }
    },
  };
}

/** Plain text with its references as chips; null when it names none. */
export function forgeText(
  text: string,
  defaultProject: ForgeProject | null,
): ReactNode | null {
  const matches = findForgeMentions(text)
    .map((match) => ({
      match,
      ref: resolveForgeMention(match.mention, defaultProject),
    }))
    .filter((found) => found.ref);
  if (!matches.length) return null;
  const out: ReactNode[] = [];
  let at = 0;
  for (const { match, ref } of matches) {
    if (match.start > at) out.push(text.slice(at, match.start));
    out.push(
      <ForgeChip
        key={match.start}
        forgeRef={ref!}
        written={match.text}
        writtenUrl={match.mention.kind === "url" ? match.text : undefined}
      />,
    );
    at = match.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Gives a chat's messages their chips. */
export function ForgeChatProvider({
  chat,
  children,
}: {
  chat: ForgeChat | null;
  children: ReactNode;
}) {
  const defaultProject = chat?.defaultProject ?? null;
  const slots = useMemo<ForgeSlots | null>(
    () =>
      chat
        ? {
            mark: (root, options) =>
              markForgeReferences(
                root,
                defaultProject,
                (ref, written, url) => (
                  // The slot sits in a chat message: the chat's context.
                  <ForgeChatContext.Provider value={chat}>
                    <ForgeChip
                      forgeRef={ref}
                      written={written}
                      writtenUrl={url}
                    />
                  </ForgeChatContext.Provider>
                ),
                options,
              ),
            renderText: (text) => forgeText(text, defaultProject),
          }
        : null,
    [chat, defaultProject],
  );
  return (
    <ForgeChatContext.Provider value={chat}>
      <ForgeSlotsContext.Provider value={slots}>
        {children}
      </ForgeSlotsContext.Provider>
    </ForgeChatContext.Provider>
  );
}

/** Whether an element is on screen (or close to it). */
export function useOnScreen(
  ref: React.RefObject<Element | null>,
  margin = "200px",
): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, margin]);
  return visible;
}

export function pipelineLabel(status: ForgePipelineStatus): string {
  return {
    running: "Pipeline running",
    pending: "Pipeline pending",
    success: "Pipeline passed",
    failed: "Pipeline failed",
    canceled: "Pipeline canceled",
    skipped: "Pipeline skipped",
    manual: "Pipeline waiting for a manual job",
  }[status];
}

export function PipelineIcon({
  status,
  size = 13,
}: {
  status: ForgePipelineStatus;
  size?: number;
}) {
  const props = {
    size,
    "aria-label": pipelineLabel(status),
    className: `forge-pipeline is-${status}`,
  };
  switch (status) {
    case "running":
      return <LoaderCircle {...props} />;
    case "pending":
      return <Clock {...props} />;
    case "success":
      return <CircleCheck {...props} />;
    case "failed":
      return <CircleX {...props} />;
    case "canceled":
      return <CircleSlash {...props} />;
    case "skipped":
      return <CircleMinus {...props} />;
    default:
      return <CirclePause {...props} />;
  }
}

/** The state a chip shows, as words: what it is in, or why it cannot say. */
export function forgeChipState(entry: ForgeEntry): {
  tone: string;
  label: string;
  detail?: string;
} {
  const status = entry.status;
  if (!status)
    return entry.failures
      ? { tone: "error", label: "unreachable" }
      : { tone: "loading", label: "" };
  switch (status.state) {
    case "not_signed_in":
      return {
        tone: "muted",
        label: `not signed in to ${status.ref.host}`,
        detail: status.message,
      };
    case "unavailable":
      return { tone: "muted", label: "unavailable", detail: status.message };
    case "not_found":
      return { tone: "muted", label: "not found", detail: status.message };
    case "error":
      return { tone: "error", label: "unreachable", detail: status.message };
  }
  const request = status.request!;
  const label =
    request.state === "open"
      ? request.draft
        ? "draft"
        : "open"
      : request.state;
  return { tone: request.draft && label === "draft" ? "draft" : label, label };
}

function StateIcon({ status }: { status: ForgeStatus | null }) {
  const request = status?.request;
  if (!request) return <GitPullRequest size={13} aria-hidden />;
  if (request.state === "merged") return <GitMerge size={13} aria-hidden />;
  if (request.state !== "open")
    return <GitPullRequestClosed size={13} aria-hidden />;
  if (request.draft) return <GitPullRequestDraft size={13} aria-hidden />;
  return <GitPullRequest size={13} aria-hidden />;
}

const HOVER_DELAY_MS = 300;
const LEAVE_DELAY_MS = 200;

/**
 * A merge or pull request named in a message: its number, state, pipeline,
 * approvals and open threads; its title and more on hover. A click opens
 * its page.
 */
export function ForgeChip({
  forgeRef,
  written,
  writtenUrl,
  variant = "inline",
}: {
  forgeRef: ForgeRef;
  /** The reference as the message wrote it. */
  written?: string;
  /** The URL the message wrote, linked until the forge answers. */
  writtenUrl?: string;
  variant?: "inline" | "header";
}) {
  const chat = useForgeChat();
  const element = useRef<HTMLSpanElement>(null);
  const onScreen = useOnScreen(element);
  const entry = useForgeStatus(
    chat?.client ?? null,
    forgeRef,
    onScreen,
    chat?.workspaceId ?? "",
  );
  const [card, setCard] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const status = entry.status;
  const request = status?.state === "ready" ? status.request : undefined;
  const state = forgeChipState(entry);
  const label =
    written && !written.startsWith("https://")
      ? written
      : sameProject(forgeRef, chat?.defaultProject ?? null)
        ? forgeRefLabel(forgeRef, true)
        : forgeRefLabel(forgeRef);
  // Only the request's own page, as the forge answered it; until then the
  // URL the message itself had.
  const href = request?.url ?? writtenUrl;
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (element.current) setCard(element.current.getBoundingClientRect());
    }, HOVER_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCard(null), LEAVE_DELAY_MS);
  };
  const title = request?.title;
  const body = (
    <>
      <StateIcon status={status} />
      <span className="forge-chip-ref">{label}</span>
      <span className="forge-chip-info">
        {state.label ? (
          <span className={`forge-chip-state is-${state.tone}`}>
            {state.label}
          </span>
        ) : (
          <LoaderCircle
            size={11}
            className="forge-chip-loading"
            aria-label="Loading"
          />
        )}
        {request?.pipeline ? (
          <PipelineIcon status={request.pipeline.status} />
        ) : null}
        {request?.approvals?.count ? (
          <span
            className="forge-chip-count"
            title={`${request.approvals.count} approval${request.approvals.count === 1 ? "" : "s"}`}
          >
            <ThumbsUp size={11} aria-hidden />
            {request.approvals.count}
          </span>
        ) : null}
        {request?.unresolved ? (
          <span
            className="forge-chip-count is-threads"
            title={`${request.unresolved} unresolved thread${request.unresolved === 1 ? "" : "s"}`}
          >
            <MessageSquare size={11} aria-hidden />
            {request.unresolved}
          </span>
        ) : null}
        {title && variant === "inline" ? (
          <span className="forge-chip-title">{title}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <span
      ref={element}
      className={`forge-chip is-${variant} is-${state.tone}`}
      data-forge-ref={`${forgeRef.provider}:${forgeRef.host}/${forgeRef.project}#${forgeRef.number}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {href ? (
        <a
          className="forge-chip-main"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={state.detail}
        >
          {body}
        </a>
      ) : (
        <span className="forge-chip-main" title={state.detail}>
          {body}
        </span>
      )}
      {card && status
        ? createPortal(
            <Suspense fallback={null}>
              <ForgeHoverCard
                status={status}
                anchor={card}
                onEnter={() => clearTimeout(timer.current)}
                onLeave={hide}
              />
            </Suspense>,
            document.body,
          )
        : null}
    </span>
  );
}

export { forgeKind };
