import { describe, expect, test } from "bun:test";
import {
  browserSharesRoamgateHost,
  canForwardPorts,
  localForwardFor,
} from "./portForwarding";

describe("forward availability", () => {
  test("offered only when the browser and Roamgate share a machine", () => {
    expect(browserSharesRoamgateHost("localhost")).toBe(true);
    expect(browserSharesRoamgateHost("127.0.0.1")).toBe(true);
    // Reached over the network: a forward would bind on the server's host and
    // resolve to the wrong machine here.
    expect(browserSharesRoamgateHost("desktop.local")).toBe(false);
    expect(browserSharesRoamgateHost("192.168.1.10")).toBe(false);
    expect(browserSharesRoamgateHost("")).toBe(false);
  });
});

describe("forwarding gate", () => {
  test("needs both an SSH connection and a browser on Roamgate's machine", () => {
    expect(canForwardPorts("ssh", "localhost")).toBe(true);
    expect(canForwardPorts("ssh", "[::1]")).toBe(true);
    // The palette and switcher once offered forwarding here: the forward
    // would bind on the server's host, not the browser's.
    expect(canForwardPorts("ssh", "desktop.tail1234.ts.net")).toBe(false);
    expect(canForwardPorts("local", "localhost")).toBe(false);
    expect(canForwardPorts(undefined, "localhost")).toBe(false);
  });
});

test("a reverse or starting forward cannot open a remote terminal URL", () => {
  const base = {
    id: "forward",
    connection_id: "ssh",
    direction: "local" as const,
    local_port: 3001,
    remote_port: 3000,
    state: "open" as const,
  };
  expect(
    localForwardFor([{ ...base, direction: "remote" }], "ssh", 3000),
  ).toBeUndefined();
  expect(
    localForwardFor([{ ...base, state: "starting" }], "ssh", 3000),
  ).toBeUndefined();
  expect(localForwardFor([base], "other", 3000)).toBeUndefined();
  expect(localForwardFor([base], "ssh", 3000)?.local_port).toBe(3001);
});
