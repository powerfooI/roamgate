import { type RefObject, useEffect, useRef, useState } from "react";

export function useSuggestedName(
  open: boolean,
  initialValue: string | (() => Promise<string>),
  input: RefObject<HTMLInputElement | null>,
) {
  const [value, setValue] = useState("");
  const pendingName = useRef<symbol | null>(null);
  useEffect(() => {
    if (!open) return;
    const request = Symbol();
    pendingName.current = request;
    if (typeof initialValue === "string") setValue(initialValue);
    else {
      setValue("");
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
        () => {},
      );
    }
    return () => {
      pendingName.current = null;
    };
  }, [open, initialValue, input]);

  return [
    value,
    (name: string) => {
      pendingName.current = null;
      setValue(name);
    },
  ] as const;
}
