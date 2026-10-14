export const MINIMUM_HERDR_PROTOCOL = 14;
export const MAXIMUM_HERDR_PROTOCOL = 22;

export class HerdrCompatibilityError extends Error {}

// Retain legacy codecs (14-20); tagged Herdr 0.9.0 and 0.9.4 both use 22.
// Protocol 21 and future versions must never be echoed through either codec.
export function isSupportedHerdrProtocol(
  protocol: unknown,
): protocol is number {
  return (
    typeof protocol === "number" &&
    Number.isSafeInteger(protocol) &&
    ((protocol >= MINIMUM_HERDR_PROTOCOL && protocol <= 20) || protocol === 22)
  );
}

// Private terminal protocol 22 is distinct from stable endpoint generation 1.
export function isTerminalHelloProtocol(protocol: number): boolean {
  return protocol === 22;
}

// Herdr 0.8.2 inserted AppDirectGraphics before TerminalAttach.
export const APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL = 20;

export function terminalAttachLaunchModeWireValue(protocol: number): number {
  return protocol >= APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL ? 2 : 1;
}

export function assertSupportedHerdrProtocol(
  protocol: unknown,
): asserts protocol is number {
  if (isSupportedHerdrProtocol(protocol)) return;
  const actual =
    typeof protocol === "number" || typeof protocol === "string"
      ? String(protocol)
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
          .slice(0, 20)
      : "unknown";
  throw new HerdrCompatibilityError(
    `Herdr protocol ${actual} is not supported by this Roamgate build ` +
      "(supports protocols 14-20 and 22). Use a Roamgate release explicitly " +
      "supporting this server, or a separate compatible server. Do not downgrade a live server.",
  );
}
