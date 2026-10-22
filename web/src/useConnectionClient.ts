import { useMemo, useSyncExternalStore } from "react";
import { bridge, type ConnectionClient } from "./api";
import { store, useStoreSelector } from "./store";

/** Catalog restoration can make the same client usable after socket hello. */
export function useConnectionReady(client: ConnectionClient): boolean {
  return useSyncExternalStore(store.subscribe, client.isCurrent);
}

/** Captures the active browser routing lease for component-owned work. */
export function useConnectionClient(): ConnectionClient {
  const activeConnectionId = useStoreSelector((s) => s.activeConnectionId);
  const connectionGeneration = useStoreSelector((s) => s.connectionGeneration);
  const connections = useStoreSelector((s) => s.connections);
  const runtimeGeneration =
    connections.find((connection) => connection.id === activeConnectionId)
      ?.generation ?? null;
  return useMemo(() => {
    // A same-ID runtime replacement must capture a fresh Bridge generation.
    void connectionGeneration;
    return bridge.connection(activeConnectionId, runtimeGeneration);
  }, [activeConnectionId, connectionGeneration, runtimeGeneration]);
}

export function connectionClientScopeKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  ...parts: unknown[]
): string {
  return JSON.stringify([client.connectionId, client.generation, ...parts]);
}
