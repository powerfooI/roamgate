import { expect, spyOn, test } from "bun:test";
import { copyTextWithFeedback } from "./copyText";
import { store } from "./store";

test.each(["missing", "denied", "older failure", "older success"])(
  "copy notification handles %s without stale feedback",
  async (scenario) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const notify = spyOn(store, "notify").mockImplementation(() => {});
    const olderWrite = Promise.withResolvers<void>();
    let writes = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard:
          scenario === "missing"
            ? undefined
            : {
                writeText: () => {
                  if (scenario === "denied")
                    return Promise.reject(new Error("Clipboard denied"));
                  if (++writes === 1) return olderWrite.promise;
                  return scenario === "older failure"
                    ? Promise.resolve()
                    : Promise.reject(new Error("latest copy denied"));
                },
              },
      },
    });
    try {
      if (scenario === "missing" || scenario === "denied") {
        await copyTextWithFeedback("unavailable");
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]![0]).toMatchObject({
          kind: "error",
          detail:
            scenario === "denied"
              ? "Clipboard denied"
              : "browser clipboard access is unavailable",
        });
      } else {
        const older = copyTextWithFeedback("older");
        expect(notify).not.toHaveBeenCalled();
        await copyTextWithFeedback("latest");
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]![0]).toMatchObject(
          scenario === "older failure"
            ? {
                kind: "success",
                message: "Copied to clipboard",
                autoDismissMs: 3000,
              }
            : { kind: "error", detail: "latest copy denied" },
        );
        if (scenario === "older failure")
          olderWrite.reject(new Error("older copy denied"));
        else olderWrite.resolve();
        await older;
        expect(notify).toHaveBeenCalledTimes(1);
      }
    } finally {
      notify.mockRestore();
      if (descriptor)
        Object.defineProperty(globalThis, "navigator", descriptor);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  },
);
