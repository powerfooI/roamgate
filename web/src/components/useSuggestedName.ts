import { type RefObject, useEffect, useRef, useState } from "react";

export function useSuggestedName(
  open: boolean,
  initialValue: string | (() => Promise<string>),
  input: RefObject<HTMLInputElement | null>,
) {
  const [value, setValue] = useState<string | null>(null);
  const pendingName = useRef<symbol | null>(null);
  useEffect(() => {
    if (!open) return;
    const request = Symbol();
    pendingName.current = request;
    if (typeof initialValue === "string") setValue(initialValue);
    else {
      setValue(null);
      void initialValue().then(
        (name) => {
          if (request !== pendingName.current) return;
          setValue(name);
          window.requestAnimationFrame(() => {
            if (
              request === pendingName.current &&
              document.activeElement === input.current
            )
              input.current?.select();
          });
        },
        // A name suggestion is optional; keep manual entry available.
        () => {
          if (request === pendingName.current) setValue("");
        },
      );
    }
    return () => {
      pendingName.current = null;
    };
  }, [open, initialValue, input]);

  return [
    value ?? "",
    (name: string) => {
      pendingName.current = null;
      setValue(name);
    },
    value === null,
  ] as const;
}
