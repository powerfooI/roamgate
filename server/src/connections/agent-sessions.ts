import type { HerdrClient } from "../bridge/herdr-client";
import {
  type ConnectionManager,
  type ConnectionRuntime,
  sanitizeConnectionError,
} from "./manager";

/** Read summaries without changing a browser's active connection or starting runtimes. */
export async function readConnectionAgentSessions<
  Runtime extends ConnectionRuntime & {
    herdr: Pick<HerdrClient, "call">;
    worktreeParents?: { enrichWorkspaceList(result: any): Promise<any> };
    status: { enrichWorkspacesWithGitStatus(result: any): Promise<any> };
    agentSessions: {
      listWithActivity(params: Record<string, unknown>): Promise<unknown>;
    };
    remotePlatform?: string;
  },
>(manager: Pick<ConnectionManager<Runtime>, "list" | "readyRuntimeLease">) {
  const results = await Promise.all(
    manager.list().map(async (connection) => {
      const lease = manager.readyRuntimeLease(connection.id);
      if (!lease) return null;
      const identity = {
        connection_id: connection.id,
        connection_generation: lease.generation,
      };
      try {
        const [workspaces, tabs, panes, agents] = await Promise.all([
          lease.runtime.herdr.call("workspace.list", {}, 5000),
          lease.runtime.herdr.call("tab.list", {}, 5000),
          lease.runtime.herdr.call("pane.list", {}, 5000),
          (lease.runtime.remotePlatform === "windows"
            ? lease.runtime.herdr.call("agent.list", {}, 5000)
            : lease.runtime.agentSessions.listWithActivity({})
          ).catch(() => null),
        ]);
        if (
          !Array.isArray(workspaces?.workspaces) ||
          !Array.isArray(tabs?.tabs) ||
          !Array.isArray(panes?.panes)
        ) {
          throw new Error("Invalid session list from Herdr");
        }
        let enriched = lease.runtime.worktreeParents
          ? await lease.runtime.worktreeParents.enrichWorkspaceList(workspaces)
          : workspaces;
        if (lease.runtime.remotePlatform !== "windows") {
          enriched =
            await lease.runtime.status.enrichWorkspacesWithGitStatus(enriched);
        }
        return {
          isCurrent: lease.isCurrent,
          snapshot: {
            ...identity,
            workspaces: enriched.workspaces,
            tabs: tabs.tabs,
            panes: panes.panes,
            agents,
          },
        };
      } catch (error) {
        return {
          isCurrent: lease.isCurrent,
          snapshot: {
            ...identity,
            workspaces: [],
            tabs: [],
            panes: [],
            agents: null,
            error: sanitizeConnectionError(error),
          },
        };
      }
    }),
  );
  return {
    connections: results.flatMap((result) =>
      result?.isCurrent() ? [result.snapshot] : [],
    ),
  };
}
