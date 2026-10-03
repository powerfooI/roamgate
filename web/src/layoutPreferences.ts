import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

export const LAYOUT_PREFERENCES_STORAGE_KEY = "layoutPreferences.v1";
export const LAYOUT_CHANGE_EVENT = "herdr-layout-change";
export const MOBILE_BREAKPOINT_DEFAULT = 768;
export const MOBILE_BREAKPOINT_MIN = 320;
export const MOBILE_BREAKPOINT_MAX = 2560;

export type LayoutMode = "auto" | "mobile" | "desktop";
export type SidebarOrder = "workspaces-first" | "agents-first";
export type LayoutPreferences = {
  mode: LayoutMode;
  mobileBreakpoint: number;
  mobileSidebarOrder: SidebarOrder;
  desktopSidebarOrder: SidebarOrder;
};

const defaults: LayoutPreferences = {
  mode: "auto",
  mobileBreakpoint: MOBILE_BREAKPOINT_DEFAULT,
  mobileSidebarOrder: "agents-first",
  desktopSidebarOrder: "workspaces-first",
};

export function parseLayoutPreferences(raw: string | null): LayoutPreferences {
  let value: Partial<LayoutPreferences> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {
    // Invalid or older browser preferences fall back to defaults.
  }
  return {
    mode:
      value.mode === "mobile" || value.mode === "desktop" ? value.mode : "auto",
    mobileBreakpoint:
      typeof value.mobileBreakpoint === "number" &&
      Number.isFinite(value.mobileBreakpoint)
        ? Math.min(
            MOBILE_BREAKPOINT_MAX,
            Math.max(MOBILE_BREAKPOINT_MIN, Math.round(value.mobileBreakpoint)),
          )
        : MOBILE_BREAKPOINT_DEFAULT,
    mobileSidebarOrder:
      value.mobileSidebarOrder === "workspaces-first"
        ? "workspaces-first"
        : "agents-first",
    desktopSidebarOrder:
      value.desktopSidebarOrder === "agents-first"
        ? "agents-first"
        : "workspaces-first",
  };
}

export function layoutUrlOverride(search: string): LayoutMode | null {
  const mode = new URLSearchParams(search).get("layout");
  return mode === "mobile" || mode === "desktop" || mode === "auto"
    ? mode
    : null;
}

export function resolveMobileLayout(
  width: number,
  preferences: LayoutPreferences,
  search = "",
): boolean {
  const mode = layoutUrlOverride(search) ?? preferences.mode;
  return (
    mode === "mobile" ||
    (mode === "auto" && width <= preferences.mobileBreakpoint)
  );
}

type LayoutSnapshot = {
  preferences: LayoutPreferences;
  mobile: boolean;
  urlOverride: LayoutMode | null;
};
const serverSnapshot: LayoutSnapshot = {
  preferences: defaults,
  mobile: false,
  urlOverride: null,
};
let snapshot = serverSnapshot;
let initialized = false;
const listeners = new Set<() => void>();

function publishLayout(preferences = snapshot.preferences) {
  const mobile = resolveMobileLayout(
    window.innerWidth,
    preferences,
    window.location.search,
  );
  const urlOverride = layoutUrlOverride(window.location.search);
  document.documentElement.dataset.layout = mobile ? "mobile" : "desktop";
  if (
    preferences === snapshot.preferences &&
    mobile === snapshot.mobile &&
    urlOverride === snapshot.urlOverride
  )
    return;
  const layoutChanged = mobile !== snapshot.mobile;
  snapshot = { preferences, mobile, urlOverride };
  for (const listener of listeners) listener();
  if (layoutChanged) window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
}

function readPreferences() {
  try {
    return parseLayoutPreferences(
      roamgateLocalStorage.getItem(LAYOUT_PREFERENCES_STORAGE_KEY),
    );
  } catch {
    return { ...defaults };
  }
}

export function initializeLayoutPreferences() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  publishLayout(readPreferences());
  window.addEventListener("resize", () => publishLayout());
  window.addEventListener("popstate", () => publishLayout());
  subscribeLocalStorage((key) => {
    if (key === LAYOUT_PREFERENCES_STORAGE_KEY || key === null)
      publishLayout(readPreferences());
  });
}

export function updateLayoutPreferences(patch: Partial<LayoutPreferences>) {
  const preferences = parseLayoutPreferences(
    JSON.stringify({ ...snapshot.preferences, ...patch }),
  );
  // An explicit choice in the menu supersedes this tab's URL override.
  if (
    patch.mode !== undefined &&
    layoutUrlOverride(window.location.search) !== null
  ) {
    const url = new URL(window.location.href);
    url.searchParams.delete("layout");
    window.history.replaceState(window.history.state, "", url);
  }
  try {
    roamgateLocalStorage.setItem(
      LAYOUT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Keep this session usable when browser storage is unavailable.
  }
  publishLayout(preferences);
}

function subscribe(listener: () => void) {
  initializeLayoutPreferences();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isMobileLayout() {
  return snapshot.mobile;
}

export function useLayoutPreferences() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => serverSnapshot,
  );
}
