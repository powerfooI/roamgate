import { afterEach, expect, test } from "bun:test";
import type { ConnectionSummary } from "./api";
import type { PullRequestSummary } from "../../shared/pullRequest";
import { roamgateLocalStorage } from "./browserStorage";
import {
  PULL_REQUEST_CACHE_KEY,
  pullRequestConnectionKey,
  readPullRequestCache,
  writePullRequestCache,
} from "./pullRequestCache";

const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
afterEach(() => {
  if (originalStorage)
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}
const status: PullRequestSummary = {
  state: "ready",
  provider: "gitlab",
  refreshedAt: "2026-10-22T00:00:00Z",
  request: {
    id: "2#7",
    number: 7,
    title: "Feature",
    author: "alice",
    source: "topic",
    target: "main",
    state: "merged",
    draft: false,
    url: "https://git.example.com/team/repo/-/merge_requests/7",
  },
};

test("review cache persists only successful summaries, bounds history, and invalidates definitive misses", () => {
  installStorage();
  for (let i = 0; i < 205; i++)
    writePullRequestCache(`checkout-${i}`, "topic", status);
  expect(readPullRequestCache().size).toBe(200);
  expect(readPullRequestCache().has("checkout-0")).toBe(false);
  expect(readPullRequestCache().get("checkout-204")).toEqual({
    branch: "topic",
    status,
  });
  writePullRequestCache("checkout-204", "detached", status);
  expect(readPullRequestCache().get("checkout-204")?.branch).toBe("topic");
  writePullRequestCache("checkout-204", "topic", {
    ...status,
    state: "no_match",
    request: undefined,
  });
  expect(readPullRequestCache().has("checkout-204")).toBe(false);
});

test("review cache rejects corrupt records and unsafe URLs without losing valid records", () => {
  installStorage();
  const record = { branch: "topic", status };
  for (const raw of ["{", "null", "{}", '"text"']) {
    roamgateLocalStorage.setItem(PULL_REQUEST_CACHE_KEY, raw);
    expect(readPullRequestCache().size).toBe(0);
  }
  const invalid = [
    null,
    { ...record, branch: "detached" },
    { ...record, status: { ...status, refreshedAt: "invalid" } },
    { ...record, status: { ...status, provider: "other" } },
    ...[
      "javascript:alert(1)",
      "data:text/html,bad",
      "https://user:password@example.com",
    ].map((url) => ({
      ...record,
      status: { ...status, request: { ...status.request, url } },
    })),
  ];
  roamgateLocalStorage.setItem(
    PULL_REQUEST_CACHE_KEY,
    JSON.stringify([
      ["good", record],
      ...invalid.map((entry, i) => [`bad-${i}`, entry]),
    ]),
  );
  expect([...readPullRequestCache().keys()]).toEqual(["good"]);
});

test("review cache tolerates unavailable browser storage", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  expect(readPullRequestCache().size).toBe(0);
  expect(() =>
    writePullRequestCache("checkout", "topic", status),
  ).not.toThrow();
});

test("review cache identity follows the connection destination, not reconnect generations or labels", () => {
  const connection: ConnectionSummary = {
    id: "a",
    label: "Server",
    source: "ssh",
    is_default: true,
    state: "ready",
    generation: 1,
    type: "ssh",
    ssh_destination: "user@host",
    remote_control_socket_path: "/tmp/herdr.sock",
  };
  const key = pullRequestConnectionKey(connection);
  expect(
    pullRequestConnectionKey({
      ...connection,
      generation: 8,
      label: "Renamed",
      state: "reconnecting",
    }),
  ).toBe(key);
  for (const patch of [
    { id: "b" },
    { ssh_destination: "user@other" },
    { remote_control_socket_path: "/tmp/other.sock" },
    { remote_session: "other" },
  ])
    expect(pullRequestConnectionKey({ ...connection, ...patch })).not.toBe(key);
  expect(pullRequestConnectionKey()).toBeNull();
});
