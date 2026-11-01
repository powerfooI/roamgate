import "./ImageLightbox.css";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";

/**
 * An image over the whole app, fitted to the window: a click on it shows it
 * at its own size, Esc, the backdrop or the close button put it away.
 */
export function ImageLightbox({
  src,
  name,
  onClose,
  returnFocus = true,
}: {
  src: string;
  name: string;
  onClose: () => void;
  /** Off, nothing keeps the focus once it is put away. */
  returnFocus?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [actualSize, setActualSize] = useState(false);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open) dialog.close?.();
      if (returnFocus) opener?.focus({ preventScroll: true });
      // close() gives it back on its own.
      else if (opener && document.activeElement === opener) opener.blur();
    };
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal-backdrop image-lightbox"
      aria-label={`Image: ${name}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // The app's shortcuts stay out while the image is shown.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        // Not to the chat it is drawn from (React passes portal clicks up).
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="image-lightbox-bar">
        <span className="image-lightbox-name" title={name}>
          {name}
        </span>
        <a
          className="image-lightbox-button"
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in a new tab"
          title="Open in a new tab"
        >
          <ExternalLink size={15} aria-hidden="true" />
        </a>
        <button
          type="button"
          className="image-lightbox-button"
          onClick={onClose}
          // Enter right after opening must not leave for a tab.
          autoFocus
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div
        className={`image-lightbox-stage${actualSize ? " is-actual" : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {/* Zoom is a pointer convenience; Esc and the buttons work by keyboard. */}
        <img
          src={src}
          alt={name}
          draggable={false}
          title={actualSize ? "Fit to the window" : "Actual size"}
          onClick={() => setActualSize((actual) => !actual)}
        />
      </div>
    </dialog>,
    document.body,
  );
}
