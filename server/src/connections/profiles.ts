import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { defaultDataFile, publishDataFile } from "../config/data-paths";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { validateSshDestination } from "../bridge/ssh-command";
import { nativeSocketPath } from "../config/server-config";
import { roamgateEnv } from "../config/environment";
import { validateConnectionId } from "./protocol";
import { LEGACY_DEFAULT_CONNECTION_ID } from "./types";

export const CONNECTION_PROFILE_FILE_VERSION = 2;
export const MAX_CONNECTION_PROFILES = 64;
const MAX_PROFILE_FILE_BYTES = 1024 * 1024;
const MAX_LABEL_LENGTH = 80;
const MAX_SOCKET_PATH_LENGTH = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type LocalConnectionProfile = {
  id: string;
  label: string;
  type: "local";
  control_socket_path: string;
  client_socket_path: string;
  auto_connect: boolean;
};

export type SshConnectionProfile = {
  id: string;
  label: string;
  type: "ssh";
  ssh_destination: string;
  remote_control_socket_path: string;
  remote_client_socket_path: string;
  auto_connect: boolean;
  remote_platform?: "windows";
  remote_herdr_path?: string;
  remote_session?: string;
};

export type ConnectionProfile = LocalConnectionProfile | SshConnectionProfile;

export function connectionRecoveryFingerprint(
  profile: ConnectionProfile,
): string {
  const target =
    profile.type === "local"
      ? [profile.type, profile.control_socket_path, profile.client_socket_path]
      : [
          profile.type,
          profile.ssh_destination,
          profile.remote_control_socket_path,
          profile.remote_client_socket_path,
          ...(profile.remote_platform === "windows"
            ? [
                profile.remote_platform,
                profile.remote_herdr_path,
                profile.remote_session,
              ]
            : []),
        ];
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

export type PersistedConnectionRegistry = {
  version: 1 | typeof CONNECTION_PROFILE_FILE_VERSION;
  default_connection_id: string;
  profiles: ConnectionProfile[];
};

export type PublicConnectionProfile = ConnectionProfile & {
  read_only: boolean;
};

export function defaultConnectionProfilesPath(): string {
  return roamgateEnv("CONNECTIONS_PATH") ?? defaultDataFile("connections.json");
}

function assertPlainObject(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  description: string,
  optionalKeys: readonly string[] = [],
): void {
  const expected = new Set([...keys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      throw new Error(`${description} has unknown field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${description} is missing field: ${key}`);
  }
}

function validateLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LABEL_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error("connection label is invalid");
  }
  return value;
}

function validateSocketPath(
  value: unknown,
  field: string,
  platform: string,
): string {
  const isWindowsPath =
    typeof value === "string" &&
    (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[.?]\\pipe\\/i.test(value));
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SOCKET_PATH_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    (platform === "win32" ? !isWindowsPath : !isAbsolute(value))
  ) {
    throw new Error(`${field} must be an absolute socket path`);
  }
  const segments = value.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`${field} must not contain parent traversal`);
  }
  const normalized = platform === "win32" ? win32.normalize(value) : value;
  const nativePath = nativeSocketPath(normalized, platform);
  if (nativePath.length > MAX_SOCKET_PATH_LENGTH) {
    throw new Error(`${field} must be an absolute socket path`);
  }
  return nativePath;
}

export function validateLocalConnectionProfile(
  value: unknown,
  platform: string = process.platform,
): LocalConnectionProfile {
  assertPlainObject(value, "connection profile");
  assertExactKeys(
    value,
    [
      "id",
      "label",
      "type",
      "control_socket_path",
      "client_socket_path",
      "auto_connect",
    ],
    "connection profile",
  );
  const id = validateConnectionId(value.id);
  if (id === LEGACY_DEFAULT_CONNECTION_ID) {
    throw new Error(`${LEGACY_DEFAULT_CONNECTION_ID} is reserved`);
  }
  if (value.type !== "local") {
    throw new Error("only local connection profiles are supported");
  }
  if (typeof value.auto_connect !== "boolean") {
    throw new Error("auto_connect must be a boolean");
  }
  return {
    id,
    label: validateLabel(value.label),
    type: "local",
    control_socket_path: validateSocketPath(
      value.control_socket_path,
      "control_socket_path",
      platform,
    ),
    client_socket_path: validateSocketPath(
      value.client_socket_path,
      "client_socket_path",
      platform,
    ),
    auto_connect: value.auto_connect,
  };
}

function validateRemoteSocketPath(value: unknown, field: string): string {
  // An empty path asks the bridge to infer the default Herdr socket location
  // under the remote home directory at connect time.
  if (value === "") return "";
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    Buffer.byteLength(value, "utf8") > 100 ||
    !value.startsWith("/") ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /[:\\\s]/.test(value)
  ) {
    throw new Error(`${field} must be a short absolute POSIX socket path`);
  }
  const segments = value.split("/").slice(1);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~+@%=-]+$/.test(segment),
    )
  ) {
    throw new Error(`${field} must be a short absolute POSIX socket path`);
  }
  return value;
}

export function validateSshConnectionProfile(
  value: unknown,
): SshConnectionProfile {
  assertPlainObject(value, "connection profile");
  assertExactKeys(
    value,
    [
      "id",
      "label",
      "type",
      "ssh_destination",
      "remote_control_socket_path",
      "remote_client_socket_path",
      "auto_connect",
    ],
    "connection profile",
    ["remote_platform", "remote_herdr_path", "remote_session"],
  );
  const id = validateConnectionId(value.id);
  if (id === LEGACY_DEFAULT_CONNECTION_ID) {
    throw new Error(`${LEGACY_DEFAULT_CONNECTION_ID} is reserved`);
  }
  if (value.type !== "ssh") throw new Error("invalid connection profile type");
  if (typeof value.auto_connect !== "boolean") {
    throw new Error("auto_connect must be a boolean");
  }
  const remoteControlSocketPath = validateRemoteSocketPath(
    value.remote_control_socket_path,
    "remote_control_socket_path",
  );
  const remoteClientSocketPath = validateRemoteSocketPath(
    value.remote_client_socket_path,
    "remote_client_socket_path",
  );
  const windows = value.remote_platform === "windows";
  if (value.remote_platform !== undefined && !windows)
    throw new Error("invalid remote_platform");
  if (
    !windows &&
    (value.remote_herdr_path !== undefined ||
      value.remote_session !== undefined)
  )
    throw new Error("Windows SSH options require remote_platform windows");
  if (windows && (remoteControlSocketPath || remoteClientSocketPath))
    throw new Error(
      "Windows SSH uses Herdr bridges instead of remote socket paths",
    );
  if (
    value.remote_herdr_path !== undefined &&
    (typeof value.remote_herdr_path !== "string" ||
      value.remote_herdr_path.length > 1024 ||
      !/^[A-Za-z]:[\\/][^\u0000-\u001f\u007f-\u009f]+\.exe$/i.test(
        value.remote_herdr_path,
      ) ||
      value.remote_herdr_path.split(/[\\/]/).includes(".."))
  )
    throw new Error(
      "remote_herdr_path must be an absolute Windows executable path",
    );
  if (
    value.remote_session !== undefined &&
    (typeof value.remote_session !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.remote_session))
  )
    throw new Error("remote_session must be a valid Herdr session name");
  if (
    remoteControlSocketPath &&
    remoteClientSocketPath &&
    remoteControlSocketPath === remoteClientSocketPath
  ) {
    throw new Error("remote control and render socket paths must differ");
  }
  return {
    id,
    label: validateLabel(value.label),
    type: "ssh",
    ssh_destination: validateSshDestination(value.ssh_destination),
    remote_control_socket_path: remoteControlSocketPath,
    remote_client_socket_path: remoteClientSocketPath,
    auto_connect: value.auto_connect,
    ...(windows ? { remote_platform: "windows" as const } : {}),
    ...(typeof value.remote_herdr_path === "string"
      ? { remote_herdr_path: value.remote_herdr_path }
      : {}),
    ...(typeof value.remote_session === "string"
      ? { remote_session: value.remote_session }
      : {}),
  };
}

export function validateConnectionProfile(
  value: unknown,
  platform: string = process.platform,
): ConnectionProfile {
  assertPlainObject(value, "connection profile");
  if (value.type === "local") {
    return validateLocalConnectionProfile(value, platform);
  }
  if (value.type === "ssh") return validateSshConnectionProfile(value);
  throw new Error("invalid connection profile type");
}

export function validateConnectionRegistry(
  value: unknown,
): PersistedConnectionRegistry {
  assertPlainObject(value, "connection registry");
  assertExactKeys(
    value,
    ["version", "default_connection_id", "profiles"],
    "connection registry",
  );
  if (
    value.version !== 1 &&
    value.version !== CONNECTION_PROFILE_FILE_VERSION
  ) {
    throw new Error("unsupported connection registry version");
  }
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error("connection registry must contain at least one profile");
  }
  if (value.profiles.length > MAX_CONNECTION_PROFILES) {
    throw new Error("connection registry contains too many profiles");
  }
  const profiles = value.profiles.map((profile) =>
    value.version === 1
      ? validateLocalConnectionProfile(profile)
      : validateConnectionProfile(profile),
  );
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id))
      throw new Error(`duplicate connection profile: ${profile.id}`);
    ids.add(profile.id);
  }
  const defaultConnectionId = validateConnectionId(value.default_connection_id);
  if (!ids.has(defaultConnectionId)) {
    throw new Error("default connection profile does not exist");
  }
  return {
    version: value.version,
    default_connection_id: defaultConnectionId,
    profiles,
  };
}

function assertNotSymlink(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("connection registry path contains a symlink");
  }
}

export type ConnectionProfileStoreOptions = {
  path?: string;
  beforeRename?: (temporaryPath: string, targetPath: string) => void;
};

export class ConnectionProfileStore {
  readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConnectionProfileStoreOptions = {}) {
    this.path = options.path ?? defaultConnectionProfilesPath();
    if (!isAbsolute(this.path))
      throw new Error("connection registry path must be absolute");
  }

  load(): PersistedConnectionRegistry | null {
    assertNotSymlink(this.path);
    if (!existsSync(this.path)) return null;
    const parent = dirname(this.path);
    assertNotSymlink(parent);
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory()) {
      throw new Error("connection registry parent is not a directory");
    }
    const descriptor = openSync(
      this.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let raw: string;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error("connection registry must be a regular file");
      }
      if (process.platform !== "win32") {
        if ((parentStat.mode & 0o077) !== 0 || (stat.mode & 0o077) !== 0) {
          if (!this.canHardenDefaultPath()) {
            throw new Error(
              "connection registry permissions must be 0700/0600",
            );
          }
          chmodSync(parent, 0o700);
          fchmodSync(descriptor, 0o600);
        }
      }
      if (stat.size > MAX_PROFILE_FILE_BYTES) {
        throw new Error("connection registry is too large");
      }
      const buffer = Buffer.alloc(MAX_PROFILE_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          null,
        );
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead > MAX_PROFILE_FILE_BYTES) {
        throw new Error("connection registry is too large");
      }
      raw = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("connection registry is not valid JSON");
    }
    return validateConnectionRegistry(parsed);
  }

  save(registry: PersistedConnectionRegistry): Promise<void> {
    const validated = validateConnectionRegistry(registry);
    const task = this.writeQueue.then(() => this.writeAtomic(validated));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  clear(): Promise<void> {
    const task = this.writeQueue.then(() => {
      const parent = dirname(this.path);
      assertNotSymlink(parent);
      if (!existsSync(parent)) {
        if (!existsSync(this.path)) return;
        throw new Error("connection registry parent does not exist");
      }
      const parentStat = lstatSync(parent);
      if (!parentStat.isDirectory()) {
        throw new Error("connection registry parent is not a directory");
      }
      if (process.platform !== "win32" && (parentStat.mode & 0o077) !== 0) {
        if (!this.canHardenDefaultPath()) {
          throw new Error(
            "connection registry parent permissions must be 0700",
          );
        }
        chmodSync(parent, 0o700);
      }
      assertNotSymlink(this.path);
      if (!existsSync(this.path)) return;
      if (
        this.options.path === undefined &&
        roamgateEnv("CONNECTIONS_PATH") === undefined
      ) {
        // Clearing saved profiles must not restore the old registry next launch.
        publishDataFile(`${this.path}.legacy-cleared`, "1\n");
      }
      unlinkSync(this.path);
      try {
        const parentFd = openSync(
          parent,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          fsyncSync(parentFd);
        } finally {
          closeSync(parentFd);
        }
      } catch {
        // Some filesystems do not support fsync on directories.
      }
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  private canHardenDefaultPath(): boolean {
    return (
      this.options.path === undefined &&
      roamgateEnv("CONNECTIONS_PATH") === undefined
    );
  }

  private writeAtomic(registry: PersistedConnectionRegistry): void {
    const payload = `${JSON.stringify(registry, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_PROFILE_FILE_BYTES) {
      throw new Error("connection registry is too large");
    }
    const parent = dirname(this.path);
    assertNotSymlink(parent);
    const parentExisted = existsSync(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertNotSymlink(parent);
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory())
      throw new Error("connection registry parent is not a directory");
    if (process.platform !== "win32") {
      if (
        parentExisted &&
        (parentStat.mode & 0o077) !== 0 &&
        !this.canHardenDefaultPath()
      ) {
        throw new Error("connection registry parent permissions must be 0700");
      }
      chmodSync(parent, 0o700);
    }
    assertNotSymlink(this.path);
    const temporaryPath = join(
      parent,
      `.connections.json.${process.pid}.${randomUUID()}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(fd, payload, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      this.options.beforeRename?.(temporaryPath, this.path);
      assertNotSymlink(this.path);
      renameSync(temporaryPath, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
      try {
        const parentFd = openSync(parent, constants.O_RDONLY);
        try {
          fsyncSync(parentFd);
        } finally {
          closeSync(parentFd);
        }
      } catch {
        // Some filesystems do not support fsync on directories.
      }
    } finally {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temp file was renamed or never created.
      }
    }
  }
}

export function publicConnectionProfile(
  profile: ConnectionProfile,
  readOnly = false,
): PublicConnectionProfile {
  if (profile.type === "ssh") {
    return {
      id: profile.id,
      label: profile.label,
      type: "ssh",
      ssh_destination: profile.ssh_destination,
      remote_control_socket_path: profile.remote_control_socket_path,
      remote_client_socket_path: profile.remote_client_socket_path,
      auto_connect: profile.auto_connect,
      read_only: readOnly,
      ...(profile.remote_platform
        ? { remote_platform: profile.remote_platform }
        : {}),
      ...(profile.remote_herdr_path
        ? { remote_herdr_path: profile.remote_herdr_path }
        : {}),
      ...(profile.remote_session
        ? { remote_session: profile.remote_session }
        : {}),
    };
  }
  return {
    id: profile.id,
    label: profile.label,
    type: "local",
    control_socket_path: profile.control_socket_path,
    client_socket_path: profile.client_socket_path,
    auto_connect: profile.auto_connect,
    read_only: readOnly,
  };
}
