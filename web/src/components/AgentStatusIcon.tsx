import { cn } from "../utils";
import { AgentIcon } from "./AgentIcon";
import { agentStateKind } from "./agentSession";
import "./AgentStatusIcon.css";

export function AgentStatusIcon({
  agent,
  status,
  className,
}: {
  agent?: string;
  status?: string;
  className?: string;
}) {
  const stateKind = agentStateKind(status);
  return (
    <span className={cn("agent-status-icon", className)} aria-hidden="true">
      <AgentIcon agent={agent} compact />
      <span className={`agent-status-icon-dot is-${stateKind}`} />
    </span>
  );
}
