/**
 * Whether the workspace inspector (Files, Changes, Commits, History) was
 * left shown, per browser, connection and workspace: showing it in one
 * workspace shows it there only, and switching back brings it back as it
 * was. Its view, dock and Zen are the checkout's (readInspectorPreferences).
 * Kept in localStorage only: another browser showing its inspector must
 * not open this one's.
 */
export const INSPECTOR_SHOWN_STORAGE_KEY = "inspectorShown.v1";

const MAX_CONNECTIONS = 64;
const MAX_WORKSPACES = 512;
const MAX_ID_LENGTH = 512;

/** connection id -> ids of the workspaces whose inspector was shown */
type ShownSpaces = Readonly<Record<string, readonly string[]>>;

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the stored value; anything malformed reads as nothing shown. */
function parseShown(value: unknown): ShownSpaces {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.connections))
    return {};
  const shown: Record<string, string[]> = {};
  for (const [connectionId, workspaces] of Object.entries(
    value.connections,
  ).slice(0, MAX_CONNECTIONS)) {
    if (!validId(connectionId) || !Array.isArray(workspaces)) continue;
    const ids = [...new Set(workspaces.filter(validId))].slice(
      0,
      MAX_WORKSPACES,
    );
    if (ids.length) shown[connectionId] = ids;
  }
  return shown;
}

function withShown(
  spaces: ShownSpaces,
  connectionId: string,
  workspaceId: string,
  shown: boolean,
): ShownSpaces {
  const others = (spaces[connectionId] ?? []).filter(
    (id) => id !== workspaceId,
  );
  const ids = shown ? [...others, workspaceId] : others;
  const result: Record<string, readonly string[]> = { ...spaces };
  if (ids.length) result[connectionId] = ids;
  else delete result[connectionId];
  return result;
}

type ShownStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readShown(storage: Pick<Storage, "getItem">) {
  try {
    const raw = storage.getItem(INSPECTOR_SHOWN_STORAGE_KEY);
    return raw ? parseShown(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Whether this browser last left the workspace's inspector shown. */
export function inspectorWasShown(
  storage: Pick<Storage, "getItem">,
  connectionId: string,
  workspaceId: string,
): boolean {
  return readShown(storage)[connectionId]?.includes(workspaceId) ?? false;
}

export function rememberInspectorShown(
  storage: ShownStorage,
  connectionId: string,
  workspaceId: string,
  shown: boolean,
): void {
  const spaces = readShown(storage);
  if ((spaces[connectionId]?.includes(workspaceId) ?? false) === shown) return;
  try {
    const next = withShown(spaces, connectionId, workspaceId, shown);
    if (Object.keys(next).length === 0)
      storage.removeItem(INSPECTOR_SHOWN_STORAGE_KEY);
    else
      storage.setItem(
        INSPECTOR_SHOWN_STORAGE_KEY,
        JSON.stringify({ version: 1, connections: next }),
      );
  } catch {
    // The inspector still works; switching back just finds it hidden.
  }
}
