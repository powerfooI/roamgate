const PREFIX = "roamgate:";
const DELETED_PREFIX = "roamgate:deleted:";

/** Keep legacy originals; deletion markers prevent removed values reappearing. */
export function roamgateStorage(storage: Storage): Storage {
  const keys = () => [
    ...new Set(
      Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter(
          (key): key is string =>
            key !== null && !key.startsWith(DELETED_PREFIX),
        )
        .map((key) =>
          key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key,
        ),
    ),
  ];
  return {
    get length() {
      return keys().length;
    },
    key(index) {
      return keys()[index] ?? null;
    },
    getItem(key) {
      const current = storage.getItem(PREFIX + key);
      if (current !== null) return current;
      if (storage.getItem(DELETED_PREFIX + encodeURIComponent(key)) !== null)
        return null;
      const legacy = storage.getItem(key);
      if (legacy !== null) {
        try {
          storage.setItem(PREFIX + key, legacy);
        } catch {
          /* Read still works when storage is full. */
        }
      }
      return legacy;
    },
    setItem(key, value) {
      storage.setItem(PREFIX + key, value);
    },
    removeItem(key) {
      storage.setItem(DELETED_PREFIX + encodeURIComponent(key), "1");
      storage.removeItem(PREFIX + key);
    },
    clear() {
      for (const key of keys()) this.removeItem(key);
    },
  };
}

function browserStorage(kind: "localStorage" | "sessionStorage"): Storage {
  const get = () => roamgateStorage(globalThis[kind]);
  return {
    get length() {
      return get().length;
    },
    key(index) {
      return get().key(index);
    },
    getItem(key) {
      try {
        return get().getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      get().setItem(key, value);
    },
    removeItem(key) {
      get().removeItem(key);
    },
    clear() {
      get().clear();
    },
  };
}

export const roamgateLocalStorage = browserStorage("localStorage");
export const roamgateSessionStorage = browserStorage("sessionStorage");

/** Reload effective values through roamgateLocalStorage, not event.newValue. */
export function subscribeLocalStorage(
  listener: (key: string | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== globalThis.localStorage) return;
    let key = event.key;
    if (key?.startsWith(DELETED_PREFIX)) {
      try {
        key = decodeURIComponent(key.slice(DELETED_PREFIX.length));
      } catch {
        return;
      }
    } else if (key?.startsWith(PREFIX)) {
      key = key.slice(PREFIX.length);
    }
    listener(key);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
