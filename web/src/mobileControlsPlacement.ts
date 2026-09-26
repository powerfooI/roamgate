import { roamgateLocalStorage } from "./browserStorage";

/**
 * Where the mobile floating control stack sits. `offsetY` lifts the whole
 * stack from its default height in CSS pixels (negative moves it down).
 */
export interface MobileControlsPlacement {
  side: "left" | "right";
  offsetY: number;
}

export const DEFAULT_MOBILE_CONTROLS_PLACEMENT: MobileControlsPlacement = {
  side: "right",
  offsetY: 0,
};

const STORAGE_KEY = "mobileControlsPlacement";
// Far beyond any screen; rejects corrupt values before clamping.
const MAX_ABS_OFFSET = 10_000;

export function parseMobileControlsPlacement(
  raw: string | null,
): MobileControlsPlacement {
  if (!raw) return DEFAULT_MOBILE_CONTROLS_PLACEMENT;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object")
      return DEFAULT_MOBILE_CONTROLS_PLACEMENT;
    const { side, offsetY } = value as Partial<MobileControlsPlacement>;
    if (
      (side !== "left" && side !== "right") ||
      typeof offsetY !== "number" ||
      !Number.isFinite(offsetY) ||
      Math.abs(offsetY) > MAX_ABS_OFFSET
    )
      return DEFAULT_MOBILE_CONTROLS_PLACEMENT;
    return { side, offsetY: Math.round(offsetY) };
  } catch {
    return DEFAULT_MOBILE_CONTROLS_PLACEMENT;
  }
}

export function readMobileControlsPlacement(
  storage: Pick<Storage, "getItem"> = roamgateLocalStorage,
): MobileControlsPlacement {
  try {
    return parseMobileControlsPlacement(storage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_MOBILE_CONTROLS_PLACEMENT;
  }
}

export function writeMobileControlsPlacement(
  placement: MobileControlsPlacement,
  storage: Pick<Storage, "setItem"> = roamgateLocalStorage,
) {
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        side: placement.side,
        offsetY: Math.round(placement.offsetY),
      }),
    );
  } catch {
    // The placement still applies for this page; it is only a convenience.
  }
}

/** Vertical geometry in CSS pixels (y grows downward). */
export interface MobileControlsStackBounds {
  /** Top edge of the highest control at `offsetY = 0`. */
  top: number;
  /** Bottom edge of the lowest control at `offsetY = 0`. */
  bottom: number;
  /** Highest allowed top edge, e.g. below the header. */
  minTop: number;
  /** Lowest allowed bottom edge, e.g. above the home indicator. */
  maxBottom: number;
}

/** Keep the whole stack in range; a stack taller than the range pins to its top. */
export function clampMobileControlsOffset(
  offsetY: number,
  bounds: MobileControlsStackBounds,
): number {
  // Lifting by `offsetY` moves every edge up by that amount.
  const maxLift = bounds.top - bounds.minTop;
  const maxDrop = bounds.maxBottom - bounds.bottom;
  const lowest = Math.min(-maxDrop, maxLift);
  return Math.round(Math.min(maxLift, Math.max(lowest, offsetY)));
}

export function mobileControlsSideForRelease(
  pointerX: number,
  viewportWidth: number,
): MobileControlsPlacement["side"] {
  return pointerX < viewportWidth / 2 ? "left" : "right";
}
