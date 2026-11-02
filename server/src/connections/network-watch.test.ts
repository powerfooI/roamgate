import { expect, jest, test } from "bun:test";
import type { networkInterfaces } from "node:os";
import { networkFingerprint, watchNetworkChanges } from "./network-watch";

type Interfaces = ReturnType<typeof networkInterfaces>;

function iface(address: string, internal = false) {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

test("fingerprints only external addresses, in a stable order", () => {
  const a: Interfaces = {
    lo0: [iface("127.0.0.1", true)],
    en0: [iface("192.168.1.2")],
    utun1: [iface("10.0.0.2")],
  };
  const b: Interfaces = {
    utun1: [iface("10.0.0.2")],
    en0: [iface("192.168.1.2")],
  };
  expect(networkFingerprint(() => a)).toBe(networkFingerprint(() => b));
  expect(networkFingerprint(() => a)).not.toContain("127.0.0.1");
});

test("reports a change of addresses once, not every poll", () => {
  jest.useFakeTimers();
  try {
    let current: Interfaces = { lo0: [iface("127.0.0.1", true)] };
    let changes = 0;
    const stop = watchNetworkChanges(() => (changes += 1), {
      intervalMs: 1000,
      read: () => current,
    });
    jest.advanceTimersByTime(3000);
    expect(changes).toBe(0);

    current = { ...current, en0: [iface("192.168.1.2")] };
    jest.advanceTimersByTime(3000);
    expect(changes).toBe(1);

    stop();
    current = {};
    jest.advanceTimersByTime(3000);
    expect(changes).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});
