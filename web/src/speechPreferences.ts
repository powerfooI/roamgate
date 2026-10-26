import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

export type SpeechPreferences = { voiceURI: string; rate: number };
const KEY = "speechPreferences";
const defaults: SpeechPreferences = { voiceURI: "", rate: 1 };

export function parseSpeechPreferences(
  value: string | null,
): SpeechPreferences {
  try {
    const parsed = JSON.parse(value ?? "null");
    return {
      voiceURI: typeof parsed?.voiceURI === "string" ? parsed.voiceURI : "",
      rate:
        typeof parsed?.rate === "number" && Number.isFinite(parsed.rate)
          ? Math.max(0.5, Math.min(2, parsed.rate))
          : 1,
    };
  } catch {
    return { ...defaults };
  }
}

let snapshot = defaults;
const listeners = new Set<() => void>();
let initialized = false;
function publish(value: SpeechPreferences) {
  if (value.voiceURI === snapshot.voiceURI && value.rate === snapshot.rate)
    return;
  snapshot = value;
  for (const listener of listeners) listener();
}
function read() {
  return parseSpeechPreferences(roamgateLocalStorage.getItem(KEY));
}
function initialize() {
  if (initialized) return;
  initialized = true;
  publish(read());
  subscribeLocalStorage((key) => {
    if (key === KEY || key === null) publish(read());
  });
}
function subscribe(listener: () => void) {
  initialize();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function updateSpeechPreferences(patch: Partial<SpeechPreferences>) {
  initialize();
  const value = parseSpeechPreferences(
    JSON.stringify({ ...snapshot, ...patch }),
  );
  try {
    roamgateLocalStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Preferences remain usable for this session when storage is blocked.
  }
  publish(value);
}
export function useSpeechPreferences() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => defaults,
  );
}
