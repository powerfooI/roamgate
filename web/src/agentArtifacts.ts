import { useEffect, useState } from "react";
import type { SessionArtifact } from "../../server/src/agent/session-artifacts";
import type { Pane } from "./types";
import { useConnectionClient } from "./useConnectionClient";

export type { SessionArtifact };

const POLL_MS = 10_000;

/** The pages a Claude pane's session published, the most recent first. */
export function useAgentArtifacts(
  pane: Pane,
  enabled: boolean,
): SessionArtifact[] {
  const client = useConnectionClient();
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  const claude = enabled && pane.agent === "claude";
  useEffect(() => {
    if (!claude) {
      setArtifacts([]);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = (await client.call("agent_artifacts.get", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
        })) as { artifacts?: SessionArtifact[] };
        if (live) setArtifacts(result.artifacts ?? []);
      } catch {
        // Not readable now (a reconnect): the next poll tries again.
      }
      if (live) timer = window.setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    client,
    claude,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  return artifacts;
}
