import { describe, expect, test } from "bun:test";
import {
  chooseFileDownloadStrategy,
  filenameFromContentDisposition,
  isIosDevice,
  isStandaloneDisplay,
} from "./downloadFile";

describe("isIosDevice", () => {
  test("detects iPhones, iPads, and iPads reporting as Macintosh", () => {
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  test("rejects desktop browsers", () => {
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });
});

describe("isStandaloneDisplay", () => {
  test("accepts the media query or the iOS navigator flag", () => {
    expect(isStandaloneDisplay(true, undefined)).toBe(true);
    expect(isStandaloneDisplay(false, true)).toBe(true);
    expect(isStandaloneDisplay(false, false)).toBe(false);
    expect(isStandaloneDisplay(false, undefined)).toBe(false);
  });
});

describe("filenameFromContentDisposition", () => {
  test("prefers the extended UTF-8 filename", () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="fallback.jsonl"; filename*=UTF-8''${encodeURIComponent("会话 1.jsonl")}`,
      ),
    ).toBe("会话 1.jsonl");
  });

  test("falls back to the quoted filename and rejects junk", () => {
    expect(
      filenameFromContentDisposition('attachment; filename="a.jsonl"'),
    ).toBe("a.jsonl");
    expect(filenameFromContentDisposition("attachment")).toBeNull();
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition(undefined)).toBeNull();
    // Malformed percent-encoding falls through instead of throwing.
    expect(
      filenameFromContentDisposition("filename*=UTF-8''%E0%A4%A"),
    ).toBeNull();
  });
});

describe("chooseFileDownloadStrategy", () => {
  test("prefers the native share sheet on iOS when files can be shared", () => {
    for (const env of [
      { canShareFiles: true, standalone: true, ios: true },
      { canShareFiles: true, standalone: false, ios: true },
    ]) {
      expect(chooseFileDownloadStrategy(env)).toBe("share");
    }
  });

  test("opens a new browsing context on iOS or in a PWA without share", () => {
    for (const env of [
      { canShareFiles: false, standalone: true, ios: false },
      { canShareFiles: false, standalone: false, ios: true },
      { canShareFiles: false, standalone: true, ios: true },
    ]) {
      expect(chooseFileDownloadStrategy(env)).toBe("new-context");
    }
  });

  test("keeps the non-iOS standalone fallback when Mobile layout is forced", () => {
    // Layout gating is covered by downloadFile.browser.test.ts. This helper
    // handles device fallbacks only after the app has selected Mobile layout.
    expect(
      chooseFileDownloadStrategy({
        canShareFiles: true,
        standalone: true,
        ios: false,
      }),
    ).toBe("new-context");
  });

  test("keeps the anchor fallback for non-iOS mobile browsers", () => {
    expect(
      chooseFileDownloadStrategy({
        canShareFiles: false,
        standalone: false,
        ios: false,
      }),
    ).toBe("anchor");
  });

  test("does not add sharing to non-iOS browsers in Mobile layout", () => {
    // macOS Safari reports navigator.canShare support for files; the share
    // sheet is still not the expected desktop download path.
    expect(
      chooseFileDownloadStrategy({
        canShareFiles: true,
        standalone: false,
        ios: false,
      }),
    ).toBe("anchor");
  });
});
