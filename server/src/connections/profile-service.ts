import { HerdrClient } from "../bridge/herdr-client";
import {
  assertSupportedHerdrProtocol,
  HerdrCompatibilityError,
} from "../bridge/protocol-compat";
import { createSshTunnelManager, SshTunnelError } from "../bridge/ssh-tunnel";
import { ThinClient } from "../bridge/thin-client";
import { runProcess } from "../utils/process-utils";
import {
  ConnectionManager,
  type ConnectionRuntime,
  type ConnectionRuntimeFactory,
} from "./manager";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
  CONNECTION_PROFILE_FILE_VERSION,
  type LocalConnectionProfile,
  type PersistedConnectionRegistry,
  type PublicConnectionProfile,
  publicConnectionProfile,
  validateConnectionProfile,
} from "./profiles";
import { createSshProfileRuntimeConfig } from "./ssh-profile-runtime";
import { type ConnectionIdentity, LEGACY_DEFAULT_CONNECTION_ID } from "./types";

export type SyntheticLocalProfile = LocalConnectionProfile & {
  id: typeof LEGACY_DEFAULT_CONNECTION_ID;
};

export type ManagedConnectionProfile =
  | ConnectionProfile
  | SyntheticLocalProfile;

export type ConnectionProfileBootstrap = {
  defaultConnectionId: string;
  explicitLegacyOverride: boolean;
  persistedRegistry: PersistedConnectionRegistry | null;
  /** Set when startup preserved an invalid registry and fell back to legacy. */
  registryLoadError?: string;
  registrations: Array<{
    profile: ManagedConnectionProfile;
    readOnly: boolean;
  }>;
};

export function loadConnectionProfileBootstrap(args: {
  store: ConnectionProfileStore;
  legacyProfile: SyntheticLocalProfile;
  explicitLegacyOverride: boolean;
}): ConnectionProfileBootstrap {
  const persistedRegistry = args.store.load();
  const persisted =
    persistedRegistry?.profiles.map((profile) => ({
      profile,
      readOnly: false,
    })) ?? [];
  if (args.explicitLegacyOverride) {
    return {
      defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
      explicitLegacyOverride: true,
      persistedRegistry,
      registrations: [
        { profile: args.legacyProfile, readOnly: true },
        ...persisted,
      ],
    };
  }
  if (persistedRegistry) {
    return {
      defaultConnectionId: persistedRegistry.default_connection_id,
      explicitLegacyOverride: false,
      persistedRegistry,
      registrations: persisted,
    };
  }
  return {
    defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
    explicitLegacyOverride: false,
    persistedRegistry: null,
    registrations: [{ profile: args.legacyProfile, readOnly: true }],
  };
}

export function connectionIdentityForProfile(
  profile: ManagedConnectionProfile,
): ConnectionIdentity {
  return {
    id: profile.id,
    label: profile.label,
    source:
      profile.id === LEGACY_DEFAULT_CONNECTION_ID
        ? "legacy-config"
        : profile.type === "ssh"
          ? "ssh-profile"
          : "local-profile",
  };
}

export type ConnectionProfileRuntimeFactory<Runtime extends ConnectionRuntime> =
  (profile: ManagedConnectionProfile) => ConnectionRuntimeFactory<Runtime>;

export type ConnectionProfileListItem = ReturnType<
  ConnectionManager<ConnectionRuntime>["status"]
> &
  PublicConnectionProfile;

type RetryTimer = { cancel(): void };

export class ConnectionProbeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionProbeError";
  }
}

export type ConnectionRetryOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  stableResetMs?: number;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => RetryTimer;
};

type RetryState = {
  enabled: boolean;
  attempt: number;
  token: number;
  retryTimer: RetryTimer | null;
  stableTimer: RetryTimer | null;
};

export async function testConnectionSockets(
  controlSocketPath: string,
  clientSocketPath: string,
): Promise<{ ok: true; version: string | null; protocol: number }> {
  const herdr = new HerdrClient(controlSocketPath);
  let thinClient: ThinClient | null = null;
  try {
    const ping = await herdr.call("ping", {}, 8_000);
    const protocol: unknown = ping?.protocol;
    try {
      assertSupportedHerdrProtocol(protocol);
    } catch (error) {
      throw new ConnectionProbeError((error as Error).message, false, {
        cause: error,
      });
    }
    thinClient = new ThinClient(clientSocketPath, async () => protocol);
    // ThinClient mirrors runtime failures through EventEmitter in addition to
    // rejecting connect(). A probe has no long-lived consumer, but it still
    // must register an error listener before opening the socket so ordinary
    // render failures remain contained by this promise.
    thinClient.on("error", () => undefined);
    try {
      await thinClient.connect(80, 24);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent =
        error instanceof HerdrCompatibilityError ||
        /(?:protocol .*not supported|rejected thin-client protocol|welcomed protocol|unsupported encoding|bincode:|invalid protocol version)/i.test(
          message,
        );
      throw new ConnectionProbeError(message, !permanent, { cause: error });
    }
    return {
      ok: true,
      version: typeof ping?.version === "string" ? ping.version : null,
      protocol,
    };
  } finally {
    thinClient?.close();
  }
}

export function testLocalConnectionProfile(
  profile: LocalConnectionProfile | SyntheticLocalProfile,
) {
  return testConnectionSockets(
    profile.control_socket_path,
    profile.client_socket_path,
  );
}

export async function testConnectionProfile(profile: ManagedConnectionProfile) {
  if (profile.type === "local") return testLocalConnectionProfile(profile);
  const config = createSshProfileRuntimeConfig(profile);
  const tunnel = createSshTunnelManager({ config, runProcess });
  try {
    await tunnel.startAutoSshTunnel();
    return await testConnectionSockets(
      config.socketPath,
      config.clientSocketPath,
    );
  } finally {
    await tunnel.cleanupAutoSshTunnel();
  }
}

export class ConnectionProfileService<
  Runtime extends ConnectionRuntime = ConnectionRuntime,
> {
  private readonly profiles = new Map<
    string,
    {
      profile: ManagedConnectionProfile;
      readOnly: boolean;
    }
  >();
  private registry: PersistedConnectionRegistry | null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly retryStates = new Map<string, RetryState>();
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryStableResetMs: number;
  private readonly retryRandom: () => number;
  private readonly retrySchedule: (
    callback: () => void,
    delayMs: number,
  ) => RetryTimer;
  private supervisionStopped = false;
  private mutationDisabledError: string | null;

  constructor(
    private readonly args: {
      manager: ConnectionManager<Runtime>;
      store: ConnectionProfileStore;
      bootstrap: ConnectionProfileBootstrap;
      createRuntime: ConnectionProfileRuntimeFactory<Runtime>;
      testProfile?: typeof testConnectionProfile;
      retry?: ConnectionRetryOptions;
    },
  ) {
    this.registry = args.bootstrap.persistedRegistry;
    this.mutationDisabledError = args.bootstrap.registryLoadError
      ? "connection registry is invalid; repair or remove it before changing profiles"
      : null;
    this.retryBaseDelayMs = Math.max(1, args.retry?.baseDelayMs ?? 1000);
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      args.retry?.maxDelayMs ?? 30_000,
    );
    this.retryMaxAttempts = Math.max(1, args.retry?.maxAttempts ?? 6);
    this.retryStableResetMs = Math.max(1, args.retry?.stableResetMs ?? 30_000);
    this.retryRandom = args.retry?.random ?? Math.random;
    this.retrySchedule =
      args.retry?.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      });
    for (const registration of args.bootstrap.registrations) {
      this.profiles.set(registration.profile.id, registration);
      args.manager.register({
        identity: connectionIdentityForProfile(registration.profile),
        createRuntime: args.createRuntime(registration.profile),
      });
    }
  }

  list(): ConnectionProfileListItem[] {
    return this.args.manager.list().map((status) => {
      const entry = this.requireProfile(status.id);
      return {
        ...status,
        ...publicConnectionProfile(entry.profile, entry.readOnly),
      };
    });
  }

  willRetry(connectionId: string, error: unknown): boolean {
    const entry = this.profiles.get(connectionId);
    const state = this.retryStates.get(connectionId);
    return Boolean(
      !this.supervisionStopped &&
        entry?.profile.type === "ssh" &&
        state?.enabled &&
        state.attempt < this.retryMaxAttempts &&
        (!(error instanceof SshTunnelError) || error.retryable) &&
        (!(error instanceof ConnectionProbeError) || error.retryable),
    );
  }

  runtimeFailed(connectionId: string, error: unknown): void {
    this.scheduleRetry(connectionId, error);
    void this.args.manager.retireFailedRuntime(connectionId);
  }

  stopSupervision(): void {
    this.supervisionStopped = true;
    for (const connectionId of this.retryStates.keys()) {
      this.disableRetry(connectionId);
    }
  }

  async startConfigured(): Promise<void> {
    const targets = new Set<string>([this.args.manager.defaultId()]);
    for (const { profile } of this.profiles.values()) {
      if (profile.auto_connect) targets.add(profile.id);
    }
    await Promise.all(
      Array.from(targets, (connectionId) =>
        this.startManaged(connectionId, true).catch(() => undefined),
      ),
    );
  }

  create(value: unknown): Promise<ConnectionProfileListItem> {
    return this.mutate(async () => {
      this.requireWritableRegistryState();
      const profile = validateConnectionProfile(value);
      if (this.profiles.has(profile.id) || this.args.manager.has(profile.id)) {
        throw new Error(`connection already exists: ${profile.id}`);
      }
      const previousRegistry = this.registry;
      const migration =
        !previousRegistry && !this.args.bootstrap.explicitLegacyOverride;
      // The first persisted profile retires the synthetic legacy default.
      // Keep the local server in the list by persisting it as a writable
      // Local profile with the same socket paths instead of dropping it.
      const migrationSeed = migration
        ? this.localMigrationSeed(profile.id)
        : null;
      const nextRegistry: PersistedConnectionRegistry = previousRegistry
        ? {
            ...previousRegistry,
            version: CONNECTION_PROFILE_FILE_VERSION,
            profiles: [...previousRegistry.profiles, profile],
          }
        : {
            version: CONNECTION_PROFILE_FILE_VERSION,
            default_connection_id: migrationSeed?.id ?? profile.id,
            profiles: migrationSeed ? [migrationSeed, profile] : [profile],
          };
      await this.args.store.save(nextRegistry);
      try {
        if (migrationSeed) {
          this.args.manager.register({
            identity: connectionIdentityForProfile(migrationSeed),
            createRuntime: this.args.createRuntime(migrationSeed),
          });
        }
        this.args.manager.register({
          identity: connectionIdentityForProfile(profile),
          createRuntime: this.args.createRuntime(profile),
        });
      } catch (error) {
        try {
          if (migrationSeed && this.args.manager.has(migrationSeed.id)) {
            await this.args.manager.unregister(migrationSeed.id);
          }
          if (previousRegistry) await this.args.store.save(previousRegistry);
          else await this.args.store.clear();
        } catch (rollbackError) {
          this.disableMutationsAfterRollbackFailure();
          throw new AggregateError(
            [error, rollbackError],
            "connection creation failed and persistence rollback was incomplete",
            { cause: rollbackError },
          );
        }
        throw error;
      }
      if (migrationSeed) {
        this.profiles.set(migrationSeed.id, {
          profile: migrationSeed,
          readOnly: false,
        });
      }
      this.profiles.set(profile.id, { profile, readOnly: false });
      this.registry = nextRegistry;
      if (migration) {
        this.args.manager.setDefault(nextRegistry.default_connection_id);
        await this.args.manager.unregister(LEGACY_DEFAULT_CONNECTION_ID);
        this.profiles.delete(LEGACY_DEFAULT_CONNECTION_ID);
      }
      if (migrationSeed) {
        await this.startManaged(migrationSeed.id, true).catch(() => undefined);
      }
      if (
        profile.auto_connect ||
        this.args.manager.defaultId() === profile.id
      ) {
        await this.startManaged(profile.id, true).catch(() => undefined);
      }
      return this.item(profile.id);
    });
  }

  private localMigrationSeed(
    newProfileId: string,
  ): LocalConnectionProfile | null {
    const legacyProfile = this.args.bootstrap.registrations.find(
      (registration) =>
        registration.profile.id === LEGACY_DEFAULT_CONNECTION_ID,
    )?.profile;
    if (!legacyProfile || legacyProfile.type !== "local") return null;
    return {
      id: newProfileId === "local" ? "localhost" : "local",
      label: "Local",
      type: "local",
      control_socket_path: legacyProfile.control_socket_path,
      client_socket_path: legacyProfile.client_socket_path,
      auto_connect: true,
    };
  }

  update(
    connectionId: unknown,
    value: unknown,
  ): Promise<ConnectionProfileListItem> {
    return this.mutate(async () => {
      this.requireWritableRegistryState();
      if (typeof connectionId !== "string")
        throw new Error("connection id is required");
      const current = this.requireWritableProfile(connectionId);
      const replacement = validateConnectionProfile(value);
      if (replacement.id !== connectionId) {
        throw new Error("connection profile id cannot be changed");
      }
      const registry = this.requireRegistry();
      const previousState = this.args.manager.status(connectionId).state;
      const wasReady = previousState === "ready";
      const shouldRemainConnected =
        wasReady ||
        previousState === "connecting" ||
        previousState === "reconnecting" ||
        this.retryStates.get(connectionId)?.enabled === true;
      if (wasReady) await this.test(replacement);
      const nextRegistry: PersistedConnectionRegistry = {
        ...registry,
        version: CONNECTION_PROFILE_FILE_VERSION,
        profiles: registry.profiles.map((profile) =>
          profile.id === connectionId ? replacement : profile,
        ),
      };
      await this.args.store.save(nextRegistry);
      this.disableRetry(connectionId);
      try {
        await this.args.manager.replace({
          identity: connectionIdentityForProfile(replacement),
          createRuntime: this.args.createRuntime(replacement),
        });
        this.profiles.set(connectionId, {
          profile: replacement,
          readOnly: false,
        });
        this.registry = nextRegistry;
        if (
          shouldRemainConnected ||
          replacement.auto_connect ||
          this.args.manager.defaultId() === connectionId
        ) {
          await this.startManaged(connectionId, true);
        }
      } catch (error) {
        this.disableRetry(connectionId);
        const rollbackFailures: unknown[] = [];
        let persistenceRolledBack = true;
        try {
          await this.args.store.save(registry);
        } catch (rollbackError) {
          persistenceRolledBack = false;
          rollbackFailures.push(rollbackError);
          this.disableMutationsAfterRollbackFailure();
        }
        if (persistenceRolledBack) {
          this.profiles.set(connectionId, {
            profile: current,
            readOnly: false,
          });
          this.registry = registry;
          try {
            await this.args.manager.replace({
              identity: connectionIdentityForProfile(current),
              createRuntime: this.args.createRuntime(current),
            });
            if (shouldRemainConnected) {
              await this.startManaged(connectionId, true);
            }
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
        } else {
          // The replacement was durably written before runtime replacement
          // began. If writing the old registry back fails, keep memory aligned
          // with that last known durable value and retire all affected routing.
          this.profiles.set(connectionId, {
            profile: replacement,
            readOnly: false,
          });
          this.registry = nextRegistry;
          try {
            await this.args.manager.stop(connectionId);
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
        }
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            "connection update failed and rollback was incomplete",
            { cause: error },
          );
        }
        throw error;
      }
      return this.item(connectionId);
    });
  }

  remove(connectionId: unknown): Promise<{ ok: true }> {
    return this.mutate(async () => {
      this.requireWritableRegistryState();
      if (typeof connectionId !== "string")
        throw new Error("connection id is required");
      const current = this.requireWritableProfile(connectionId);
      if (this.args.manager.defaultId() === connectionId) {
        throw new Error("cannot remove the default connection");
      }
      const registry = this.requireRegistry();
      const nextProfiles = registry.profiles.filter(
        (profile) => profile.id !== connectionId,
      );
      const nextRegistry: PersistedConnectionRegistry | null =
        nextProfiles.length > 0
          ? {
              ...registry,
              version: CONNECTION_PROFILE_FILE_VERSION,
              profiles: nextProfiles,
            }
          : null;
      if (!nextRegistry && !this.args.bootstrap.explicitLegacyOverride) {
        throw new Error("cannot remove the last persisted connection");
      }
      const previousState = this.args.manager.status(connectionId).state;
      const shouldRecoverConnection =
        previousState === "ready" ||
        previousState === "connecting" ||
        previousState === "reconnecting" ||
        this.retryStates.get(connectionId)?.enabled === true;

      // Retire routing first. If persistence then fails, the existing durable
      // registry still describes the old profile and we can safely restore its
      // factory without ever exposing a profile that disk says was removed.
      this.disableRetry(connectionId);
      await this.args.manager.unregister(connectionId);
      try {
        if (nextRegistry) await this.args.store.save(nextRegistry);
        else await this.args.store.clear();
      } catch (error) {
        const recoveryFailures: unknown[] = [];
        try {
          this.args.manager.register({
            identity: connectionIdentityForProfile(current),
            createRuntime: this.args.createRuntime(current),
          });
          if (shouldRecoverConnection) {
            await this.startManaged(connectionId, true);
          }
        } catch (recoveryError) {
          recoveryFailures.push(recoveryError);
        }
        if (recoveryFailures.length > 0) {
          throw new AggregateError(
            [error, ...recoveryFailures],
            "connection removal failed and runtime recovery was incomplete",
            { cause: error },
          );
        }
        throw error;
      }
      this.profiles.delete(connectionId);
      this.registry = nextRegistry;
      return { ok: true };
    });
  }

  setDefault(
    connectionId: unknown,
  ): Promise<{ ok: true; default_connection_id: string }> {
    return this.mutate(async () => {
      this.requireWritableRegistryState();
      if (typeof connectionId !== "string")
        throw new Error("connection id is required");
      if (this.args.bootstrap.explicitLegacyOverride) {
        throw new Error(
          "explicit CLI/environment connection remains the process default",
        );
      }
      this.requireWritableProfile(connectionId);
      const registry = this.requireRegistry();
      const nextRegistry: PersistedConnectionRegistry = {
        ...registry,
        version: CONNECTION_PROFILE_FILE_VERSION,
        default_connection_id: connectionId,
      };
      await this.args.store.save(nextRegistry);
      try {
        this.args.manager.setDefault(connectionId);
      } catch (error) {
        try {
          await this.args.store.save(registry);
        } catch (rollbackError) {
          this.disableMutationsAfterRollbackFailure();
          throw new AggregateError(
            [error, rollbackError],
            "default connection update failed and persistence rollback was incomplete",
            { cause: rollbackError },
          );
        }
        throw error;
      }
      this.registry = nextRegistry;
      return { ok: true, default_connection_id: connectionId };
    });
  }

  connect(connectionId: unknown): Promise<ConnectionProfileListItem> {
    return this.mutate(async () => {
      if (typeof connectionId !== "string")
        throw new Error("connection id is required");
      this.requireProfile(connectionId);
      await this.startManaged(connectionId, true);
      return this.item(connectionId);
    });
  }

  disconnect(connectionId: unknown): Promise<ConnectionProfileListItem> {
    return this.mutate(async () => {
      if (typeof connectionId !== "string")
        throw new Error("connection id is required");
      this.requireProfile(connectionId);
      this.disableRetry(connectionId);
      await this.args.manager.stop(connectionId);
      return this.item(connectionId);
    });
  }

  async test(
    value: unknown,
  ): Promise<{ ok: true; version: string | null; protocol: number }> {
    let profile: ManagedConnectionProfile;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { id?: unknown }).id === "string" &&
      Object.keys(value).length === 1
    ) {
      profile = this.requireProfile((value as { id: string }).id).profile;
    } else {
      profile = validateConnectionProfile(value);
    }
    return (this.args.testProfile ?? testConnectionProfile)(profile);
  }

  private retryState(connectionId: string): RetryState {
    let state = this.retryStates.get(connectionId);
    if (!state) {
      state = {
        enabled: false,
        attempt: 0,
        token: 0,
        retryTimer: null,
        stableTimer: null,
      };
      this.retryStates.set(connectionId, state);
    }
    return state;
  }

  private enableRetry(connectionId: string): void {
    const entry = this.requireProfile(connectionId);
    if (entry.profile.type !== "ssh" || this.supervisionStopped) return;
    const state = this.retryState(connectionId);
    state.token += 1;
    state.retryTimer?.cancel();
    state.stableTimer?.cancel();
    state.retryTimer = null;
    state.stableTimer = null;
    state.attempt = 0;
    state.enabled = true;
  }

  private disableRetry(connectionId: string): void {
    const state = this.retryStates.get(connectionId);
    if (!state) return;
    state.enabled = false;
    state.token += 1;
    state.retryTimer?.cancel();
    state.stableTimer?.cancel();
    state.retryTimer = null;
    state.stableTimer = null;
  }

  private markStable(connectionId: string): void {
    const state = this.retryStates.get(connectionId);
    if (!state?.enabled || state.attempt === 0) return;
    state.stableTimer?.cancel();
    const token = state.token;
    state.stableTimer = this.retrySchedule(() => {
      if (!state.enabled || state.token !== token) return;
      state.attempt = 0;
      state.stableTimer = null;
    }, this.retryStableResetMs);
  }

  private async startManaged(
    connectionId: string,
    resetRetry: boolean,
  ): Promise<void> {
    const entry = this.requireProfile(connectionId);
    if (entry.profile.type === "ssh" && resetRetry) {
      this.enableRetry(connectionId);
    }
    const generationBeforeStart =
      this.args.manager.status(connectionId).generation;
    try {
      await this.args.manager.start(connectionId);
      if (this.args.manager.status(connectionId).state === "ready") {
        this.markStable(connectionId);
      }
    } catch (error) {
      // A transport can report its own exit while startup is still awaiting a
      // functional socket probe. That callback advances the generation and
      // marks reconnecting before it queues a retry. Use that durable manager
      // state rather than timer timing to avoid consuming a second attempt.
      const status = this.args.manager.status(connectionId);
      const transportAlreadyReported =
        status.state === "reconnecting" &&
        status.generation > generationBeforeStart;
      if (!transportAlreadyReported) this.scheduleRetry(connectionId, error);
      throw error;
    }
  }

  private scheduleRetry(connectionId: string, error: unknown): boolean {
    if (!this.willRetry(connectionId, error)) return false;
    const state = this.retryState(connectionId);
    state.retryTimer?.cancel();
    state.stableTimer?.cancel();
    state.retryTimer = null;
    state.stableTimer = null;
    if (!this.args.manager.markReconnecting(connectionId, error)) return false;

    const windowMs = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** state.attempt,
    );
    const random = Math.max(0, Math.min(1, this.retryRandom()));
    const delayMs = Math.floor(windowMs / 2 + random * (windowMs / 2));
    state.attempt += 1;
    const token = state.token;
    state.retryTimer = this.retrySchedule(() => {
      if (!state.enabled || state.token !== token) return;
      state.retryTimer = null;
      void this.runScheduledRetry(connectionId, state, token);
    }, delayMs);
    return true;
  }

  private async runScheduledRetry(
    connectionId: string,
    state: RetryState,
    token: number,
  ): Promise<void> {
    try {
      // A timer may fire before the failed runtime has finished cleanup. Wait
      // here, then re-check the retry token, instead of queueing an
      // uncancellable manager.start() behind stopTask.
      await this.args.manager.retireFailedRuntime(connectionId);
    } catch (cleanupError) {
      if (state.enabled && state.token === token) {
        this.scheduleRetry(connectionId, cleanupError);
      }
      return;
    }
    if (!state.enabled || state.token !== token) return;
    // startManaged owns failure classification and generation-based duplicate
    // suppression for both initial and timer-triggered startups.
    await this.startManaged(connectionId, false).catch(() => undefined);
  }

  private item(connectionId: string): ConnectionProfileListItem {
    const status = this.args.manager.status(connectionId);
    const entry = this.requireProfile(connectionId);
    return {
      ...status,
      ...publicConnectionProfile(entry.profile, entry.readOnly),
    };
  }

  private requireProfile(connectionId: string) {
    const entry = this.profiles.get(connectionId);
    if (!entry) throw new Error(`unknown connection: ${connectionId}`);
    return entry;
  }

  private requireWritableProfile(connectionId: string): ConnectionProfile {
    const entry = this.requireProfile(connectionId);
    if (entry.readOnly) throw new Error("connection profile is read-only");
    return entry.profile as ConnectionProfile;
  }

  private requireRegistry(): PersistedConnectionRegistry {
    if (!this.registry) throw new Error("no persisted connection registry");
    return this.registry;
  }

  private requireWritableRegistryState(): void {
    if (this.mutationDisabledError) {
      throw new Error(this.mutationDisabledError);
    }
  }

  private disableMutationsAfterRollbackFailure(): void {
    this.mutationDisabledError =
      "connection profile mutations are disabled because persistence rollback failed; restart the bridge and repair the registry before making further changes";
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutationQueue.then(operation);
    this.mutationQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
