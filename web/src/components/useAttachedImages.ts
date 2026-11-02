import { useEffect, useRef, useState } from "react";
import type { HistoryEntry, HistoryImage } from "./agentHistory";

/** The most recent messages whose images are loaded; older ones show [Image #N]. */
const MAX_MESSAGES = 30;
const EMPTY_IMAGES: ReadonlyMap<string, readonly string[]> = new Map();

export type FetchEntryImages = (
  entryId: string,
) => Promise<readonly HistoryImage[] | undefined>;

/** A message's images: by entry, and which images. */
function imagesKey(entry: HistoryEntry) {
  return `${entry.id}:${(entry.images ?? []).map((image) => image.hash).join(",")}`;
}

function objectUrl({ media_type, data }: HistoryImage) {
  const binary = atob(data ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: media_type }));
}

type Asked = { id: string; urls?: string[] };
type Scope = {
  key: string;
  live: boolean;
  /** By images key: the entry, and its URLs once loaded. */
  asked: Map<string, Asked>;
};

function revoke(urls: readonly string[] = []) {
  for (const url of urls) URL.revokeObjectURL(url);
}

function shown(scope: Scope): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const { id, urls } of scope.asked.values()) if (urls) map.set(id, urls);
  return map;
}

/**
 * The images the user's messages carried, as object URLs by entry id. The
 * history only says a message has images; the data of the most recent
 * messages' is fetched once, and released when a message leaves them, the
 * scope (connection, pane, session) changes or the chat goes away.
 */
export function useAttachedImages(
  entries: readonly HistoryEntry[],
  fetchImages: FetchEntryImages,
  scopeKey: string,
): ReadonlyMap<string, readonly string[]> {
  const [loaded, setLoaded] = useState<{
    key: string;
    images: ReadonlyMap<string, readonly string[]>;
  }>(() => ({ key: scopeKey, images: new Map() }));
  const scopeRef = useRef<Scope | null>(null);
  const fetchRef = useRef(fetchImages);
  fetchRef.current = fetchImages;

  useEffect(() => {
    const scope: Scope = { key: scopeKey, live: true, asked: new Map() };
    scopeRef.current = scope;
    setLoaded({ key: scope.key, images: new Map() });
    return () => {
      scope.live = false;
      for (const { urls } of scope.asked.values()) revoke(urls);
    };
  }, [scopeKey]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const wanted = new Map(
      entries
        .filter((entry) => entry.role === "user" && entry.images?.length)
        .slice(-MAX_MESSAGES)
        .map((entry) => [imagesKey(entry), entry.id]),
    );
    let dropped = false;
    for (const [key, { urls }] of scope.asked)
      if (!wanted.has(key)) {
        scope.asked.delete(key);
        revoke(urls);
        dropped ||= !!urls;
      }
    if (dropped) setLoaded({ key: scope.key, images: shown(scope) });
    for (const [key, id] of wanted) {
      if (scope.asked.has(key)) continue;
      const asked: Asked = { id };
      scope.asked.set(key, asked);
      fetchRef
        .current(id)
        .then((images) => {
          // Not once the scope or the message is gone.
          if (!scope.live || scope.asked.get(key) !== asked || !images?.length)
            return;
          if (`${id}:${images.map((image) => image.hash).join(",")}` !== key)
            return;
          const urls: string[] = [];
          try {
            for (const image of images) urls.push(objectUrl(image));
          } catch (error) {
            revoke(urls);
            throw error;
          }
          asked.urls = urls;
          setLoaded({ key: scope.key, images: shown(scope) });
        })
        // A failed fetch leaves [Image #N] as text; a later history read of
        // the same message does not ask again.
        .catch(() => {});
    }
  }, [entries, scopeKey]);

  return loaded.key === scopeKey ? loaded.images : EMPTY_IMAGES;
}
