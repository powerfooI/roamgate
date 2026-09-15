import {
  ArrowDown,
  ArrowUp,
  Clipboard,
  MessageSquareText,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  diffReviewLineLabel,
  fileReviewLineLabel,
  type ReviewAnnotation,
} from "../annotations";
import type { Pane } from "../types";
import { ConfirmDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import "./AnnotationPanel.css";

function annotationLocation(annotation: ReviewAnnotation) {
  if (annotation.source === "diff") {
    return `${annotation.path} · ${diffReviewLineLabel(annotation)}`;
  }
  if (annotation.anchor === "line") {
    return `${annotation.path} · ${fileReviewLineLabel(annotation)}`;
  }
  return annotation.section.length
    ? `${annotation.path} · ${annotation.section.join(" › ")}`
    : `${annotation.path} · selected passage`;
}

function paneLabel(pane: Pane) {
  const id = pane.pane_id.length > 8 ? pane.pane_id.slice(0, 8) : pane.pane_id;
  return `${pane.agent ?? "Agent"} · ${id}`;
}

export function AnnotationPanel({
  open,
  annotations,
  agentPanes,
  preferredPaneId,
  busy,
  focusedAnnotationId,
  onClose,
  onUpdateComment,
  onDelete,
  onMove,
  onClear,
  onCopy,
  onSend,
}: {
  open: boolean;
  annotations: readonly ReviewAnnotation[];
  agentPanes: readonly Pane[];
  preferredPaneId?: string;
  busy: boolean;
  focusedAnnotationId?: string | null;
  onClose: () => void;
  onUpdateComment: (id: string, comment: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onClear: () => void;
  onCopy: () => void;
  onSend: (paneId: string | null) => void;
}) {
  const [targetPaneId, setTargetPaneId] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const preferred = agentPanes.find(
      (pane) => pane.pane_id === preferredPaneId,
    );
    setTargetPaneId((current) => {
      if (agentPanes.some((pane) => pane.pane_id === current)) return current;
      return preferred?.pane_id ?? agentPanes[0]?.pane_id ?? "";
    });
  }, [agentPanes, preferredPaneId]);

  useEffect(() => {
    if (!open || !focusedAnnotationId) return;
    requestAnimationFrame(() => {
      const card = Array.from(
        document.querySelectorAll<HTMLElement>("[data-review-annotation-id]"),
      ).find(
        (element) => element.dataset.reviewAnnotationId === focusedAnnotationId,
      );
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      card?.querySelector("textarea")?.focus({ preventScroll: true });
    });
  }, [focusedAnnotationId, open]);

  if (!open) return null;

  return (
    <aside className="annotation-panel" aria-label="Review annotations">
      <header className="annotation-panel-head">
        <div>
          <strong>Review feedback</strong>
          <span>
            {annotations.length} comment{annotations.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          className="annotation-icon-button"
          aria-label="Close review feedback"
          title="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      <div className="annotation-panel-list">
        {annotations.length === 0 ? (
          <div className="annotation-panel-empty">
            <MessageSquareText size={24} />
            <strong>No review comments yet</strong>
            <span>
              Click or drag across diff line numbers or a source gutter, or
              select rendered Markdown text.
            </span>
          </div>
        ) : (
          annotations.map((annotation, index) => (
            <article
              key={annotation.id}
              data-review-annotation-id={annotation.id}
              className={`annotation-card ${
                annotation.id === focusedAnnotationId ? "is-focused" : ""
              }`}
            >
              <div className="annotation-card-head">
                <strong title={annotationLocation(annotation)}>
                  {index + 1}. {annotationLocation(annotation)}
                </strong>
                {annotation.stale ? <span>Stale anchor</span> : null}
              </div>
              <blockquote>{annotation.quote || "Blank line"}</blockquote>
              <textarea
                value={annotation.comment}
                rows={3}
                maxLength={10_000}
                aria-label={`Comment ${index + 1}`}
                onChange={(event) =>
                  onUpdateComment(annotation.id, event.currentTarget.value)
                }
              />
              <div className="annotation-card-actions">
                <button
                  type="button"
                  className="annotation-icon-button"
                  disabled={index === 0}
                  aria-label={`Move comment ${index + 1} up`}
                  title="Move up"
                  onClick={() => onMove(annotation.id, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="annotation-icon-button"
                  disabled={index === annotations.length - 1}
                  aria-label={`Move comment ${index + 1} down`}
                  title="Move down"
                  onClick={() => onMove(annotation.id, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="annotation-icon-button is-danger"
                  aria-label={`Delete comment ${index + 1}`}
                  title="Delete"
                  onClick={() => onDelete(annotation.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      <footer className="annotation-panel-footer">
        {agentPanes.length > 1 ? (
          <label className="annotation-target-picker">
            <span>Agent pane</span>
            <ThemedSelect
              aria-label="Agent pane"
              value={targetPaneId}
              options={agentPanes.map((pane) => ({
                value: pane.pane_id,
                label: paneLabel(pane),
              }))}
              onChange={setTargetPaneId}
            />
          </label>
        ) : agentPanes.length === 1 ? (
          <div className="annotation-target-summary">
            Agent pane: {paneLabel(agentPanes[0])}
          </div>
        ) : (
          <div className="annotation-target-summary">
            No agent pane; Send uses the clipboard.
          </div>
        )}
        <div className="annotation-delivery-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy || annotations.length === 0}
            onClick={onCopy}
          >
            <Clipboard size={14} /> Copy
          </button>
          <button
            type="button"
            disabled={busy || annotations.length === 0}
            onClick={() => onSend(targetPaneId || null)}
          >
            {agentPanes.length ? <Send size={14} /> : <Clipboard size={14} />}
            {agentPanes.length ? "Pre-fill agent" : "Copy feedback"}
          </button>
        </div>
        <button
          type="button"
          className="annotation-clear-button"
          disabled={busy || annotations.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          Clear draft
        </button>
      </footer>
      <ConfirmDialog
        open={confirmClear}
        title="Clear review feedback?"
        message="This removes every unsent review comment from this draft."
        confirmLabel="Clear feedback"
        danger
        onConfirm={onClear}
        onClose={() => setConfirmClear(false)}
      />
    </aside>
  );
}
