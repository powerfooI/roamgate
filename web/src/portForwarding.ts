/**
 * Whether port forwarding is offered here. Kept apart from terminalLinks so
 * the command menu and connection switcher, which load with the app, do not
 * pull the terminal's link parsing into the initial bundle.
 */
export const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

/**
 * Whether a forward opened by the server would be reachable from this browser.
 *
 * A forward binds a local port on whichever machine runs Roamgate, so it is
 * only useful when that is also the machine holding the browser. Served over
 * loopback that is true by construction; served over a network address it is
 * not, and offering the action there would hand out an address that resolves
 * to the wrong host.
 */
export function browserSharesRoamgateHost(
  hostname: string = typeof location === "undefined" ? "" : location.hostname,
): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * The one gate every forwarding entry point uses (link click, command menu,
 * connection switcher): an SSH transport to forward over, and Roamgate on
 * the machine holding the browser.
 */
export function canForwardPorts(
  connectionType: string | undefined,
  hostname?: string,
): boolean {
  return connectionType === "ssh" && browserSharesRoamgateHost(hostname);
}
