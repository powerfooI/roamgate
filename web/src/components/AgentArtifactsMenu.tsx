import { useEffect, useRef, useState } from "react";
import { AppWindow, Copy, ExternalLink } from "lucide-react";
import type { SessionArtifact } from "../agentArtifacts";
import { copyTextWithFeedback } from "../copyText";
import { formatUiDateTime } from "../uiLocale";
import "./AgentArtifactsMenu.css";

const MENU_WIDTH = 340;
const EDGE = 16;

/** The chat's top-row button listing every page the session published. */
export function AgentArtifactsMenu({
  artifacts,
}: {
  artifacts: SessionArtifact[];
}) {
  // Where the menu opens, under the button but kept on screen: the button
  // is not always at the row's right end.
  const [place, setPlace] = useState<{ top: number; right: number } | null>(
    null,
  );
  const open = place !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setPlace(null);
  const toggle = () => {
    const button = rootRef.current?.querySelector("button");
    if (open || !button) return close();
    const rect = button.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * EDGE);
    // Its right edge under the button's, unless that pushes it off the left.
    const right = Math.max(rect.right, EDGE + width);
    setPlace({ top: rect.bottom + 6, right: window.innerWidth - right });
  };
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  if (!artifacts.length) return null;
  return (
    <div ref={rootRef} className="agent-artifacts">
      <button
        type="button"
        className="agent-history-icon agent-artifacts-button"
        aria-label={`Published artifacts: ${artifacts.length}`}
        aria-expanded={open}
        title="Artifacts this session published"
        onClick={toggle}
      >
        <AppWindow size={14} />
        <span>{artifacts.length}</span>
      </button>
      {open ? (
        <div
          className="agent-artifacts-menu"
          role="menu"
          style={{ top: place.top, right: place.right, width: MENU_WIDTH }}
        >
          <h3>Artifacts</h3>
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.url}>
                <a
                  role="menuitem"
                  href={artifact.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  <span className="agent-artifacts-title">
                    {artifact.title}
                  </span>
                  <small>
                    {artifact.version ? `v${artifact.version}` : "New"}
                    {artifact.published_at
                      ? ` · ${formatUiDateTime(artifact.published_at)}`
                      : ""}
                  </small>
                </a>
                <button
                  type="button"
                  className="agent-artifacts-copy"
                  aria-label={`Copy the link to ${artifact.title}`}
                  title="Copy link"
                  onClick={() => void copyTextWithFeedback(artifact.url)}
                >
                  <Copy size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
