import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/** Whether agent chats' message boxes take Vim keys: off unless turned on. */
const STORAGE_KEY = "agentChatVimKeys";

const listeners = new Set<() => void>();
// The choice when storage refuses it, for this page.
let pageChoice: boolean | null = null;

export function composerVimKeys(): boolean {
  if (pageChoice !== null) return pageChoice;
  try {
    return roamgateLocalStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setComposerVimKeys(on: boolean) {
  try {
    roamgateLocalStorage.setItem(STORAGE_KEY, on ? "true" : "false");
    pageChoice = null;
  } catch {
    pageChoice = on;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window's choice applies here too.
  const unsubscribe = subscribeLocalStorage((key) => {
    if (key === null || key === STORAGE_KEY) listener();
  });
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

export function useComposerVimKeys(): boolean {
  return useSyncExternalStore(subscribe, composerVimKeys, () => false);
}
