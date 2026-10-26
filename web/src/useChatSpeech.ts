import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { markdownToSpeech } from "./markdownToSpeech";
import { browserSpeechRuntime, speechPlayback } from "./speechPlayback";
import { useSpeechPreferences } from "./speechPreferences";

export function useChatSpeech(active: boolean, scopeKey: string) {
  const owner = useRef(Symbol("agent-history-speech")).current;
  const preferences = useSpeechPreferences();
  const state = useSyncExternalStore(
    speechPlayback.subscribe,
    speechPlayback.getSnapshot,
    speechPlayback.getSnapshot,
  );
  const supported = browserSpeechRuntime() !== null;
  useEffect(() => {
    if (!active) speechPlayback.stop(owner);
    return () => speechPlayback.stop(owner);
  }, [active, scopeKey, owner]);
  // Polling history must not invalidate every memoized chat bubble.
  return useMemo(
    () => ({
      supported,
      state: state.owner === owner ? state : null,
      toggle(messageId: string, markdown: string) {
        if (!active) return;
        const current = speechPlayback.getSnapshot();
        if (
          current.owner === owner &&
          current.messageId === messageId &&
          current.status === "speaking"
        ) {
          speechPlayback.stop(owner);
        } else {
          speechPlayback.start(
            owner,
            messageId,
            markdownToSpeech(markdown),
            preferences,
          );
        }
      },
    }),
    [active, owner, preferences, state, supported],
  );
}
