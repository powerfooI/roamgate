import { describe, expect, test } from "bun:test";
import { parseSessionTitle } from "./session-title";

describe("parseSessionTitle", () => {
  test("the latest generated title, unless the user named the session", () => {
    expect(parseSessionTitle([])).toBeNull();
    expect(
      parseSessionTitle([
        { type: "ai-title", aiTitle: "Network slowness" },
        { type: "user", message: {} },
        { type: "ai-title", aiTitle: "Voice chat cleaner" },
      ]),
    ).toBe("Voice chat cleaner");
    expect(
      parseSessionTitle([
        { type: "custom-title", customTitle: "roamgate" },
        { type: "ai-title", aiTitle: "Voice chat cleaner" },
      ]),
    ).toBe("roamgate");
  });

  test("an emptied name gives way to the generated title", () => {
    expect(
      parseSessionTitle([
        { type: "ai-title", aiTitle: "Voice chat cleaner" },
        { type: "custom-title", customTitle: " " },
      ]),
    ).toBe("Voice chat cleaner");
  });
});
