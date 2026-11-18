import { useEffect, useSyncExternalStore } from "react";
import {
  type ForgeRef,
  type ForgeSession,
  type ForgeStatus,
  forgeRefKey,
} from "../../shared/forge";
import type { ConnectionClient } from "./api";

/**
 * One cache of merge and pull request statuses for every chip, header and
 * list: one entry per (connection, host, project, number), asked in the
 * background lane, only while something showing it is on screen and the
 * page is visible, again at a pace that follows what can still change.
 */

/** A running or pending pipeline: it may finish any time. */
export const FORGE_RUNNING_MS = 60_000;
/** An open request: titles, approvals and threads move slowly. */
export const FORGE_OPEN_MS = 3 * 60_000;
/** Merged, closed or gone: next to nothing changes. */
export const FORGE_SETTLED_MS = 6 * 60 * 60_000;
/** Not signed in, or no glab/gh: until the user fixes it. */
export const FORGE_UNAVAILABLE_MS = 10 * 60_000;
/** After a failure: doubling from this, up to FORGE_ERROR_MAX_MS. */
export const FORGE_ERROR_MS = 30_000;
export const FORGE_ERROR_MAX_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 65_000;
/** Entries nothing shows are forgotten past this many. */
const KEPT = 300;

export type ForgeEntry = {
  status: ForgeStatus | null;
  loading: boolean;
  /** Failures in a row (transport errors, or `error` answers). */
  failures: number;
};

type Holder = { visible: boolean };

type Slot = {
  key: string;
  ref: ForgeRef;
  client: ConnectionClient;
  /** The workspace whose checkout glab and gh run in. */
  workspaceId: string;
  entry: ForgeEntry;
  /** When it was last asked (answered or not). */
  askedAt: number;
  holders: Set<Holder>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
};

/** How long an answer stands before it is asked again. */
export function forgeRefreshDelay(entry: ForgeEntry): number {
  const status = entry.status;
  if (entry.failures > 0 || status?.state === "error")
    return Math.min(
      FORGE_ERROR_MS * 2 ** Math.max(0, entry.failures - 1),
      FORGE_ERROR_MAX_MS,
    );
  if (!status) return 0;
  if (status.state === "not_signed_in" || status.state === "unavailable")
    return FORGE_UNAVAILABLE_MS;
  if (status.state !== "ready" || !status.request) return FORGE_SETTLED_MS;
  const request = status.request;
  if (request.state !== "open") return FORGE_SETTLED_MS;
  const pipeline = request.pipeline?.status;
  return pipeline === "running" || pipeline === "pending"
    ? FORGE_RUNNING_MS
    : FORGE_OPEN_MS;
}

const NOTHING: ForgeEntry = { status: null, loading: false, failures: 0 };

export function createForgeStore(
  options: { now?: () => number; pageVisible?: () => boolean } = {},
) {
  const now = options.now ?? (() => Date.now());
  const pageVisible =
    options.pageVisible ??
    (() => typeof document === "undefined" || !document.hidden);
  const slots = new Map<string, Slot>();

  function slotKey(client: ConnectionClient, ref: ForgeRef) {
    return `${client.connectionId}\u0000${forgeRefKey(ref)}`;
  }

  function publish(slot: Slot, entry: ForgeEntry) {
    slot.entry = entry;
    for (const listener of slot.listeners) listener();
  }

  function shown(slot: Slot) {
    return [...slot.holders].some((holder) => holder.visible);
  }

  function schedule(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (slot.entry.loading || !shown(slot) || !pageVisible()) return;
    const due = slot.askedAt + forgeRefreshDelay(slot.entry) - now();
    if (slot.askedAt === 0 || due <= 0) {
      void ask(slot);
      return;
    }
    slot.timer = setTimeout(() => {
      slot.timer = null;
      schedule(slot);
    }, due);
  }

  async function ask(slot: Slot, fresh = false) {
    slot.askedAt = now();
    publish(slot, { ...slot.entry, loading: true });
    let status: ForgeStatus | null;
    try {
      status = (await slot.client.call(
        "forge.status",
        {
          ref: slot.ref,
          ...(slot.workspaceId ? { workspace_id: slot.workspaceId } : {}),
          ...(fresh ? { fresh: true } : {}),
        },
        REQUEST_TIMEOUT_MS,
        { lane: "background" },
      )) as ForgeStatus;
    } catch {
      status = null;
    }
    if (slots.get(slot.key) !== slot) return;
    const failed = !status || status.state === "error";
    publish(slot, {
      // A failed refresh keeps what was known.
      status:
        status && (status.state !== "error" || !slot.entry.status)
          ? status
          : slot.entry.status,
      loading: false,
      failures: failed ? slot.entry.failures + 1 : 0,
    });
    // Answered from a shared server cache: it counts from now.
    slot.askedAt = now();
    schedule(slot);
  }

  function forget() {
    if (slots.size <= KEPT) return;
    for (const [key, slot] of slots) {
      if (slots.size <= KEPT) break;
      if (!slot.holders.size && !slot.listeners.size) {
        if (slot.timer) clearTimeout(slot.timer);
        slots.delete(key);
      }
    }
  }

  function slotFor(client: ConnectionClient, ref: ForgeRef, workspaceId = "") {
    const key = slotKey(client, ref);
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        key,
        ref,
        client,
        workspaceId,
        entry: { status: null, loading: false, failures: 0 },
        askedAt: 0,
        holders: new Set(),
        listeners: new Set(),
        timer: null,
      };
      slots.set(key, slot);
      forget();
    } else {
      // The newest client of the connection asks from now on.
      slot.client = client;
      if (workspaceId) slot.workspaceId = workspaceId;
    }
    return slot;
  }

  return {
    /** What is known of a request now. */
    get(client: ConnectionClient, ref: ForgeRef): ForgeEntry {
      return slots.get(slotKey(client, ref))?.entry ?? NOTHING;
    },
    subscribe(
      client: ConnectionClient,
      ref: ForgeRef,
      listener: () => void,
    ): () => void {
      const slot = slotFor(client, ref);
      slot.listeners.add(listener);
      return () => slot.listeners.delete(listener);
    },
    /**
     * Something showing the request: while it is visible, the request is
     * kept fresh. Returns the holder's setter and its release.
     */
    hold(client: ConnectionClient, ref: ForgeRef, workspaceId = "") {
      const slot = slotFor(client, ref, workspaceId);
      const holder: Holder = { visible: false };
      slot.holders.add(holder);
      return {
        setVisible(visible: boolean) {
          if (holder.visible === visible) return;
          holder.visible = visible;
          schedule(slot);
        },
        release() {
          slot.holders.delete(holder);
          if (!slot.holders.size && slot.timer) {
            clearTimeout(slot.timer);
            slot.timer = null;
          }
        },
      };
    },
    /** The page came back into view: what is due is asked. */
    wake() {
      for (const slot of slots.values()) schedule(slot);
    },
    /** Asks again now (a click on refresh). */
    refresh(client: ConnectionClient, ref: ForgeRef) {
      const slot = slots.get(slotKey(client, ref));
      if (!slot || slot.entry.loading) return;
      void ask(slot, true);
    },
    clear() {
      for (const slot of slots.values())
        if (slot.timer) clearTimeout(slot.timer);
      slots.clear();
    },
  };
}

export type ForgeStore = ReturnType<typeof createForgeStore>;

export const forgeStore = createForgeStore();

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) forgeStore.wake();
  });

const EMPTY: ForgeEntry = { status: null, loading: false, failures: 0 };

/** A request's status, kept fresh while `visible`. */
export function useForgeStatus(
  client: ConnectionClient | null,
  ref: ForgeRef | null,
  visible: boolean,
  workspaceId = "",
): ForgeEntry {
  const key =
    client && ref ? `${client.connectionId}\u0000${forgeRefKey(ref)}` : "";
  const entry = useSyncExternalStore(
    (listener) =>
      client && ref ? forgeStore.subscribe(client, ref, listener) : () => {},
    () => (client && ref ? forgeStore.get(client, ref) : EMPTY),
  );
  useEffect(() => {
    if (!client || !ref) return;
    const held = forgeStore.hold(client, ref, workspaceId);
    held.setVisible(visible);
    return () => held.release();
    // The key names the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client, visible, workspaceId]);
  return entry;
}

/**
 * The pipeline statuses of several requests, as known (it asks nothing:
 * their rows and chips do), joined in one string so it changes only when
 * one of them does.
 */
export function useForgePipelines(
  client: ConnectionClient | null,
  refs: ForgeRef[],
): string[] {
  const key = refs.map(forgeRefKey).join("\u0000");
  const joined = useSyncExternalStore(
    (listener) => {
      if (!client) return () => {};
      const offs = refs.map((ref) =>
        forgeStore.subscribe(client, ref, listener),
      );
      return () => {
        for (const off of offs) off();
      };
    },
    () =>
      client
        ? refs
            .map(
              (ref) =>
                forgeStore.get(client, ref).status?.request?.pipeline?.status ??
                "",
            )
            .join(",")
        : "",
  );
  void key;
  return joined ? joined.split(",") : [];
}

/** Keeps several requests fresh while `visible` (a header's "3 MRs"). */
export function useForgeHolds(
  client: ConnectionClient | null,
  refs: { ref: ForgeRef; workspaceId?: string }[],
  visible: boolean,
) {
  const key = refs
    .map(
      ({ ref, workspaceId }) => `${forgeRefKey(ref)}\u0001${workspaceId ?? ""}`,
    )
    .join("\u0000");
  useEffect(() => {
    if (!client) return;
    const held = refs.map(({ ref, workspaceId }) =>
      forgeStore.hold(client, ref, workspaceId),
    );
    for (const hold of held) hold.setVisible(visible);
    return () => {
      for (const hold of held) hold.release();
    };
    // The key names them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, visible]);
}

/** A session's repositories and their branches' requests, per pane. */
const SESSION_MS = 5 * 60_000;
const sessions = new Map<string, { at: number; session: ForgeSession }>();
const sessionListeners = new Map<string, Set<() => void>>();
const sessionAsks = new Map<string, Promise<void>>();

function sessionKey(
  client: ConnectionClient,
  params: { workspaceId?: string },
) {
  return JSON.stringify([client.connectionId, params.workspaceId ?? ""]);
}

function askSession(
  client: ConnectionClient,
  key: string,
  params: { workspaceId?: string },
) {
  const known = sessionAsks.get(key);
  if (known) return known;
  const asked = (async () => {
    try {
      const session = (await client.call(
        "forge.session",
        {
          ...(params.workspaceId ? { workspace_id: params.workspaceId } : {}),
        },
        REQUEST_TIMEOUT_MS,
        { lane: "background" },
      )) as ForgeSession;
      if (session && Array.isArray(session.repos)) {
        sessions.set(key, { at: Date.now(), session });
        for (const listener of sessionListeners.get(key) ?? []) listener();
      }
    } catch {
      // The next round asks again.
    } finally {
      sessionAsks.delete(key);
    }
  })();
  sessionAsks.set(key, asked);
  return asked;
}

/**
 * The repositories a pane's session works in and their branches'
 * requests: asked when shown, then every five minutes while the page is
 * visible.
 */
export function useForgeSession(
  client: ConnectionClient | null,
  params: { workspaceId?: string },
  enabled: boolean,
): ForgeSession | null {
  const key = client ? sessionKey(client, params) : "";
  const session = useSyncExternalStore(
    (listener) => {
      if (!key) return () => {};
      let set = sessionListeners.get(key);
      if (!set) {
        set = new Set();
        sessionListeners.set(key, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    () => (key ? (sessions.get(key)?.session ?? null) : null),
  );
  useEffect(() => {
    if (!client || !enabled || !params.workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const round = async () => {
      const known = sessions.get(key);
      if (!document.hidden && (!known || Date.now() - known.at >= SESSION_MS))
        await askSession(client, key, params);
      if (live) timer = setTimeout(round, SESSION_MS);
    };
    void round();
    const onVisible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void round();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // The key names the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client, enabled]);
  return session;
}
