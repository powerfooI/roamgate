import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertSafeDataPath, dataRoot, replaceDataFile } from "../../config/data-paths";
import { roamgateEnv } from "../../config/environment";

/**
 * OAuth state the browser must never see. Kept apart from settings.json, in
 * an owner-only file written atomically, like the Web Push VAPID keys.
 */
export type JiraCredentials = {
  version: 1;
  site_url: string;
  client_id: string;
  token_endpoint: string;
  access_token: string;
  refresh_token: string;
  /** ISO time the access token expires; refreshed shortly before. */
  expires_at: string;
};

export type JiraCredentialStore = {
  read(): JiraCredentials | null;
  write(credentials: JiraCredentials): void;
  remove(): void;
};

export function jiraCredentialsPath(): string {
  return (
    roamgateEnv("JIRA_CREDENTIALS_PATH") ??
    join(dataRoot(), "jira-credentials.json")
  );
}

function parseCredentials(text: string): JiraCredentials | null {
  try {
    const value = JSON.parse(text) as Partial<JiraCredentials>;
    if (
      value?.version === 1 &&
      typeof value.site_url === "string" &&
      typeof value.client_id === "string" &&
      typeof value.token_endpoint === "string" &&
      typeof value.access_token === "string" &&
      typeof value.refresh_token === "string" &&
      typeof value.expires_at === "string"
    )
      return value as JiraCredentials;
  } catch {}
  return null;
}

export function createJiraCredentialStore(
  path = jiraCredentialsPath(),
): JiraCredentialStore {
  return {
    read() {
      assertSafeDataPath(path);
      try {
        return parseCredentials(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write(credentials) {
      replaceDataFile(path, `${JSON.stringify(credentials)}\n`, 0o600);
    },
    remove() {
      assertSafeDataPath(path);
      rmSync(path, { force: true });
    },
  };
}

/** For tests and for the service's in-memory fallback. */
export function createMemoryCredentialStore(
  initial: JiraCredentials | null = null,
): JiraCredentialStore {
  let value = initial;
  return {
    read: () => value,
    write: (credentials) => {
      value = { ...credentials };
    },
    remove: () => {
      value = null;
    },
  };
}
