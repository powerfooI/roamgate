import { useEffect, useEffectEvent, useRef } from "react";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import { dialogKeyAction } from "./dialogKeyboard";
import { useSuggestedName } from "./useSuggestedName";

export function TextInputDialog({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  submitting = false,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string | (() => Promise<string>);
  placeholder?: string;
  submitLabel?: string;
  submitting?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useSuggestedName(open, initialValue, inputRef);
  const onCloseEvent = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const cancelFocus = focusDialogElement(inputRef.current, { select: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey);
    };
  }, [initialValue, open]);

  if (!open) return null;

  const canSubmit =
    !submitting && (typeof initialValue === "string" || !!value.trim());
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit) onSubmit(value);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={submitting}
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <label className="form-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            disabled={submitting}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder={placeholder}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onConfirmEvent = useEffectEvent(onConfirm);
  const onCloseEvent = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      const isInsideDialog = !!target && !!dialogRef.current?.contains(target);
      const focusOnButton = target instanceof HTMLButtonElement;
      const action = dialogKeyAction(e.key, isInsideDialog, focusOnButton);
      if (action === "close") {
        e.preventDefault();
        e.stopPropagation();
        onCloseEvent();
        return;
      }
      if (action === "confirm") {
        e.preventDefault();
        e.stopPropagation();
        onConfirmEvent();
        onCloseEvent();
        return;
      }
      if (action === "contain") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <p className="modal-body-text">{message}</p>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "danger" : ""}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MessageDialog({
  open,
  title,
  message,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseEvent = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      const isInsideDialog = !!target && !!dialogRef.current?.contains(target);
      const focusOnButton = target instanceof HTMLButtonElement;
      const action = dialogKeyAction(e.key, isInsideDialog, focusOnButton);
      // The OK button is the only action; both Escape and Enter dismiss.
      if (action === "close" || action === "confirm") {
        e.preventDefault();
        e.stopPropagation();
        onCloseEvent();
        return;
      }
      if (action === "contain") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal compact-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <p className="modal-body-text">{message}</p>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
