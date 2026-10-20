import { useEffect, useRef } from "react";
import { useLayoutPreferences } from "./layoutPreferences";

/**
 * Phone Back closes popups first, then nested navigation, then outer panels.
 * Equal levels close newest first.
 */
export type SystemBackLevel = "panel" | "navigation" | "popup";
const LEVELS: Record<SystemBackLevel, number> = {
  panel: 0,
  navigation: 1,
  popup: 2,
};

type Layer = { level: number; order: number; close: () => void };

/**
 * Lets the phone's Back gesture or button close an open mobile layer before
 * it leaves the page. Each open layer has one guard entry at the current URL,
 * pushed when the layer opens. Back pops one guard and closes only the top
 * layer; the remaining layers keep their own guards, so handling Back never
 * pushes an entry. Browsers skip entries a page pushes without a user gesture
 * (Chrome's back-button intervention), so a guard re-pushed while handling
 * Back would make the next Back leave the page instead of closing the next
 * layer. When layers close on screen, their guards are removed again, so the
 * next Back leaves the page in one press.
 */
export function useSystemBack(
  open: boolean,
  close: () => void,
  level: SystemBackLevel,
) {
  const { mobile } = useLayoutPreferences();
  const closeRef = useRef(close);
  closeRef.current = close;
  const active = mobile && open;

  useEffect(() => {
    if (!active) return;
    const layer: Layer = {
      level: LEVELS[level],
      order: ++openings,
      close: () => closeRef.current(),
    };
    layers.add(layer);
    scheduleReconcile();
    return () => {
      layers.delete(layer);
      scheduleReconcile();
    };
  }, [active, level]);
}

const GUARD = "roamgateBack";
const BASE = "roamgateBackBase";
const layers = new Set<Layer>();
let openings = 0;
let guards = 0;
let previousState: unknown;
let forwardBase: string | undefined;
// A real document departure is not an on-screen React unmount.
let leaving = false;
let reconcileScheduled = false;
// history.back() is asynchronous; until our own Back lands, the current entry
// is stale and a popstate is ours, not the user's.
let backPending = false;

function isGuard(state: unknown) {
  return typeof state === "object" && state !== null && GUARD in state;
}

/** Guard entries above the page's own entry: one per open layer. */
function guardDepth(state: unknown) {
  if (!isGuard(state)) return 0;
  const depth = (state as Record<string, unknown>)[GUARD];
  return typeof depth === "number" && depth > 0 ? depth : 1;
}

function baseId(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null || !(BASE in state)) return;
  const value = (state as Record<string, unknown>)[BASE];
  return typeof value === "string" ? value : undefined;
}

// Effects of one React commit run together; reconcile once after all of them,
// so layers that open and close in the same commit settle as one change.
function scheduleReconcile() {
  if (reconcileScheduled) return;
  reconcileScheduled = true;
  queueMicrotask(reconcile);
}

function reconcile() {
  reconcileScheduled = false;
  if (backPending || leaving) return;
  const depth = guardDepth(window.history.state);
  if (layers.size > 0) forwardBase = undefined;
  if (layers.size > depth) {
    const state: unknown = window.history.state;
    let base: Record<string, unknown>;
    if (depth === 0) {
      // Pair the entries so an obsolete guard can be crossed in either direction.
      base = {
        ...(typeof state === "object" && state ? state : {}),
        [BASE]: `${Date.now()}:${++guards}`,
      };
      window.history.replaceState(base, "");
    } else base = { ...(state as Record<string, unknown>) };
    for (let next = depth + 1; next <= layers.size; next += 1)
      window.history.pushState({ ...base, [GUARD]: next }, "");
    previousState = window.history.state;
  } else if (layers.size < depth && forwardBase === undefined) {
    // Layers closed on screen take their guards with them, one step at a time.
    backPending = true;
    window.history.back();
  }
}

if (typeof window !== "undefined") {
  previousState = window.history.state;
  window.addEventListener("pagehide", () => {
    leaving = true;
    forwardBase = undefined;
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
    previousState = window.history.state;
    scheduleReconcile();
  });
  // A restored/reloaded guard has no UI state of its own. Return to its base
  // without pushing another entry or truncating valid Forward history.
  scheduleReconcile();
  window.addEventListener("popstate", (event) => {
    const from = previousState;
    previousState = event.state;
    if (backPending) {
      backPending = false;
      reconcile();
      return;
    }
    if (forwardBase !== undefined) {
      const id = forwardBase;
      if (layers.size === 0 && baseId(event.state) === id) {
        if (isGuard(event.state)) {
          // A layer stack can leave several consecutive obsolete guards.
          // Keep crossing them in the same direction, without pushing history.
          if (guardDepth(event.state) > guardDepth(from))
            window.history.forward();
          else window.history.back();
          return;
        }
        forwardBase = undefined;
        backPending = true;
        window.history.back();
        return;
      }
      forwardBase = undefined;
    }
    const id = baseId(event.state);
    if (
      layers.size === 0 &&
      isGuard(event.state) &&
      id !== undefined &&
      !isGuard(from) &&
      baseId(from) === id
    ) {
      // Continue Forward past an empty guard. At the end, its next Back skips
      // the paired base instead of consuming an extra press.
      forwardBase = id;
      window.history.forward();
      return;
    }
    const depth = guardDepth(event.state);
    if (layers.size <= depth) {
      scheduleReconcile();
      return;
    }
    // The user's Back consumed guards: close as many top layers. The others
    // keep their guards, so nothing is pushed while handling Back.
    while (layers.size > depth) {
      let top: Layer | undefined;
      for (const layer of layers)
        if (
          !top ||
          layer.level > top.level ||
          (layer.level === top.level && layer.order > top.order)
        )
          top = layer;
      layers.delete(top!);
      top!.close();
    }
    scheduleReconcile();
  });
}
