import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { focusDialogElement } from "./dialogFocus";
import {
  AgentMessageContent,
  agentMessageRoleLabel,
  type AgentMessage,
} from "./AgentMessageContent";
import "./AgentMessageDialog.css";

export function AgentMessageDialog({
  message,
  onClose,
}: {
  message: AgentMessage | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageId = message?.id ?? null;

  useEffect(() => {
    if (messageId === null) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [messageId, onClose]);

  if (!message) return null;

  // Render at the document root: on mobile the transformed .app box becomes
  // the containing block for fixed elements, and the inspector slot's stacking
  // context (z-index 3) would leave the topbar (z-index 120) painted over the
  // dialog. A body-level backdrop escapes both.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal agent-message-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Full ${agentMessageRoleLabel(message).toLowerCase()} message`}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <AgentMessageContent message={message} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
