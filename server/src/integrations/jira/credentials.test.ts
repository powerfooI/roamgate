import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiraCredentialStore, type JiraCredentials } from "./credentials";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempPath() {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-jira-"));
  directories.push(directory);
  return join(directory, "jira-credentials.json");
}

const credentials: JiraCredentials = {
  version: 1,
  site_url: "https://acme.atlassian.net",
  client_id: "client",
  token_endpoint: "https://auth.example/token",
  access_token: "access",
  refresh_token: "refresh",
  expires_at: "2026-11-04T00:00:00.000Z",
};

test("credentials round-trip through an owner-only file", () => {
  const path = tempPath();
  const store = createJiraCredentialStore(path);
  expect(store.read()).toBeNull();
  store.write(credentials);
  expect(store.read()).toEqual(credentials);
  if (process.platform !== "win32")
    expect(statSync(path).mode & 0o777).toBe(0o600);
  store.remove();
  expect(store.read()).toBeNull();
});

test("a malformed credential file reads as signed out", () => {
  const path = tempPath();
  writeFileSync(path, "{\"version\":1}", { mode: 0o600 });
  expect(createJiraCredentialStore(path).read()).toBeNull();
});
