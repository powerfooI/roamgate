import {
  shortcutMatches,
  shortcutLabel,
  useShortcutPreferences,
} from "../shortcutPreferences";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import "./AnnotationComposerPopover.css";

export type AnnotationComposerDraft = {
  x: number;
  y: number;
  title: string;
  quote: string;
};

export function AnnotationComposerPopover({
  draft,
  onSave,
  onClose,
}: {
  draft: AnnotationComposerDraft | null;
  onSave: (comment: string) => void;
  onClose: () => void;
}) {
  useShortcutPreferences();
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [comment, setComment] = useState("");
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const draftX = draft?.x;
  const draftY = draft?.y;
  const draftTitle = draft?.title;
  const draftQuote = draft?.quote;

  useLayoutEffect(() => {
    if (
      draftX === undefined ||
      draftY === undefined ||
      draftTitle === undefined ||
      draftQuote === undefined
    ) {
      return;
    }
    setComment("");
    setPosition({ x: draftX, y: draftY });
    const frame = requestAnimationFrame(() => {
      const form = formRef.current;
      if (!form) return;
      const rect = form.getBoundingClientRect();
      const margin = 8;
      setPosition({
        x: Math.min(
          Math.max(margin, draftX),
          Math.max(margin, window.innerWidth - rect.width - margin),
        ),
        y: Math.min(
          Math.max(margin, draftY),
          Math.max(margin, window.innerHeight - rect.height - margin),
        ),
      });
      textareaRef.current?.focus({ preventScroll: true });
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && formRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", closeOnPointerDown, {
      capture: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOnPointerDown, {
        capture: true,
      });
    };
  }, [draftQuote, draftTitle, draftX, draftY, onClose]);

  if (!draft) return null;

  const save = () => {
    const value = comment.trim();
    if (value) onSave(value);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save();
  };

  return createPortal(
    <form
      ref={formRef}
      className="annotation-composer-popover"
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-label="Add review comment"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (shortcutMatches(event.nativeEvent, "annotation.submit")) {
          event.preventDefault();
          save();
        }
      }}
    >
      <strong>{draft.title}</strong>
      <blockquote>{draft.quote || "Blank line"}</blockquote>
      <textarea
        ref={textareaRef}
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
        placeholder="Add a review comment"
        rows={3}
        maxLength={10_000}
      />
      <div className="annotation-composer-actions">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={!comment.trim()}>
          Add comment
        </button>
      </div>
      <small>{shortcutLabel("annotation.submit")} to add</small>
    </form>,
    document.body,
  );
}
