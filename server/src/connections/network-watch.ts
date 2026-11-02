import { networkInterfaces } from "node:os";

type InterfaceReader = typeof networkInterfaces;

/** The external addresses this host has, in a stable order. */
export function networkFingerprint(
  read: InterfaceReader = networkInterfaces,
): string {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(read())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      addresses.push(`${name}|${entry.family}|${entry.address}`);
    }
  }
  return addresses.sort().join(",");
}

/**
 * Call `onChange` when the host's external addresses change, such as when
 * Wi-Fi comes back or a VPN goes up. Polls, because Bun has no portable
 * network-change event; reading the interfaces is cheap. Returns a stop
 * function.
 */
export function watchNetworkChanges(
  onChange: () => void,
  options: { intervalMs?: number; read?: InterfaceReader } = {},
): () => void {
  const read = options.read ?? networkInterfaces;
  const fingerprint = () => {
    try {
      return networkFingerprint(read);
    } catch {
      return null;
    }
  };
  let last = fingerprint();
  const timer = setInterval(() => {
    const current = fingerprint();
    if (current === null || current === last) return;
    last = current;
    onChange();
  }, options.intervalMs ?? 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
