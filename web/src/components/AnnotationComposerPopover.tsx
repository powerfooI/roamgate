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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef<HTMLElement | null>(null);
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
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    returnFocusRef.current = returnFocus;
    const form = formRef.current;
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
      onCloseRef.current();
    };
    window.addEventListener("pointerdown", closeOnPointerDown, {
      capture: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      if (form?.contains(document.activeElement) && returnFocus?.isConnected)
        returnFocus.focus({ preventScroll: true });
      window.removeEventListener("pointerdown", closeOnPointerDown, {
        capture: true,
      });
    };
  }, [draftQuote, draftTitle, draftX, draftY]);

  if (!draft) return null;

  const restoreFocus = () => {
    if (
      formRef.current?.contains(document.activeElement) &&
      returnFocusRef.current?.isConnected
    )
      returnFocusRef.current.focus({ preventScroll: true });
  };
  const close = () => {
    restoreFocus();
    onClose();
  };
  const save = () => {
    const value = comment.trim();
    if (value) {
      restoreFocus();
      onSave(value);
    }
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
        event.stopPropagation();
        if (event.key === "Tab") {
          const controls = Array.from(
            formRef.current?.querySelectorAll<HTMLElement>(
              "textarea, button:not(:disabled)",
            ) ?? [],
          );
          const next = event.shiftKey
            ? controls[controls.length - 1]
            : controls[0];
          if (
            document.activeElement ===
            (event.shiftKey ? controls[0] : controls[controls.length - 1])
          ) {
            event.preventDefault();
            next?.focus();
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          close();
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
        aria-label="Review comment"
        placeholder="Add a review comment"
        rows={3}
        maxLength={10_000}
      />
      <div className="annotation-composer-actions">
        <button type="button" className="ghost" onClick={close}>
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
