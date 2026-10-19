import { useEffect, useRef } from "react";
import type { AssistantMessage } from "../../../shared/assistant";
import "./AssistantThinking.css";

/**
 * Model reasoning for one reply, one step per model call that shared any. It
 * opens while the model is still thinking and collapses once the answer
 * starts; readers can reopen it at any time.
 */
export function AssistantThinking({
  message,
  active,
}: {
  message: Pick<
    AssistantMessage,
    "thinking" | "thinking_skipped" | "thinking_truncated"
  >;
  active: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const steps = message.thinking ?? [];
  const skipped = message.thinking_skipped ?? 0;
  const total = skipped + steps.length;
  useEffect(() => {
    if (details.current) details.current.open = active;
  }, [active]);
  useEffect(() => {
    // Follow streamed reasoning inside its own scroll box.
    if (active && body.current)
      body.current.scrollTop = body.current.scrollHeight;
  }, [active, message.thinking]);
  return (
    <details className="assistant-thinking" ref={details}>
      <summary>
        {active ? "Thinking..." : "Thinking"}
        {total > 1 ? ` (${total} steps)` : ""}
      </summary>
      <div className="assistant-thinking-body" ref={body}>
        {message.thinking_truncated ? (
          <p className="assistant-thinking-note">Earlier reasoning truncated</p>
        ) : null}
        {steps.map((step, index) => (
          <section key={skipped + index}>
            {total > 1 ? <strong>Step {skipped + index + 1}</strong> : null}
            <p>{step}</p>
          </section>
        ))}
      </div>
    </details>
  );
}
