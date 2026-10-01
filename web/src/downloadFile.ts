import { isMobileLayout } from "./layoutPreferences";

/**
 * Download strategy for file URLs. Plain anchor downloads navigate the
 * current browsing context, which iOS replaces with the system document
 * handler; in a PWA there is no way back without force-quitting the app.
 * Mobile layout prefers the native share sheet on iOS when available and
 * opens a new context on iOS/standalone so the in-app browser offers a way
 * back. Desktop layout always uses a classic anchor download.
 */
export type FileDownloadStrategy = "share" | "new-context" | "anchor";

/** Share sheets need the whole blob in memory; open large files instead. */
export const MAX_SHARE_FILE_BYTES = 64 * 1024 * 1024;

export type FileDownloadEnvironment = {
  canShareFiles: boolean;
  standalone: boolean;
  ios: boolean;
};

export function isIosDevice(
  nav: Pick<Navigator, "userAgent" | "maxTouchPoints">,
): boolean {
  return (
    /iP(hone|ad|od)/.test(nav.userAgent) ||
    (nav.userAgent.includes("Macintosh") && nav.maxTouchPoints > 1)
  );
}

export function isStandaloneDisplay(
  matchesStandaloneMedia: boolean,
  navigatorStandalone: boolean | undefined,
): boolean {
  return matchesStandaloneMedia || navigatorStandalone === true;
}

/** Device fallback policy for Mobile layout; Desktop bypasses it. */
export function chooseFileDownloadStrategy(
  env: FileDownloadEnvironment,
): FileDownloadStrategy {
  // Desktop browsers can share files too (macOS Safari pops the system
  // share sheet), but there the classic anchor download is the expected
  // behavior. Only iOS traps anchor downloads in the system document
  // handler, so only iOS uses the share sheet.
  if (env.canShareFiles && env.ios) return "share";
  if (env.standalone || env.ios) return "new-context";
  return "anchor";
}

/**
 * The server is the filename authority: prefer its Content-Disposition name
 * over client-side guesses. Handles both filename*=UTF-8'' and filename="".
 */
export function filenameFromContentDisposition(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1].trim());
      if (decoded) return decoded;
    } catch {
      // Fall through to the plain filename.
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain?.[1] || null;
}

function probeCanShareFiles(): boolean {
  try {
    return (
      typeof navigator.canShare === "function" &&
      navigator.canShare({
        files: [new File([""], "probe.txt", { type: "text/plain" })],
      })
    );
  } catch {
    return false;
  }
}

function currentDownloadEnvironment(): FileDownloadEnvironment {
  return {
    canShareFiles: probeCanShareFiles(),
    standalone: isStandaloneDisplay(
      typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches,
      (navigator as { standalone?: boolean }).standalone,
    ),
    ios: isIosDevice(navigator),
  };
}

function openInNewContext(url: string) {
  window.open(url, "_blank", "noopener");
}

function anchorDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Downloads a same-origin file URL without trapping the current context.
 * Resolves to how the download was delivered: "shared" (native share sheet,
 * including a dismissed sheet), "opened" (new browsing context), or
 * "anchored" (classic browser download).
 */
export async function downloadFileFromUrl(args: {
  url: string;
  /** Fallback name; the server's Content-Disposition name wins when present. */
  filename: string;
}): Promise<"shared" | "opened" | "anchored"> {
  // Use the app's resolved layout, including explicit preferences and URL
  // overrides. Sharing support or standalone display does not imply Mobile.
  const strategy = isMobileLayout()
    ? chooseFileDownloadStrategy(currentDownloadEnvironment())
    : "anchor";
  if (strategy === "share") {
    try {
      const response = await fetch(args.url, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`download failed (${response.status})`);
      }
      const size = Number(response.headers.get("content-length") ?? 0);
      if (size > MAX_SHARE_FILE_BYTES) {
        openInNewContext(args.url);
        return "opened";
      }
      const blob = await response.blob();
      if (blob.size > MAX_SHARE_FILE_BYTES) {
        openInNewContext(args.url);
        return "opened";
      }
      const filename =
        filenameFromContentDisposition(
          response.headers.get("content-disposition"),
        ) ||
        args.filename ||
        "download";
      const file = new File([blob], filename, {
        type: blob.type || "application/octet-stream",
      });
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if ((error as Error).name === "AbortError") return "shared";
      openInNewContext(args.url);
      return "opened";
    }
  }
  if (strategy === "new-context") {
    openInNewContext(args.url);
    return "opened";
  }
  anchorDownload(args.url, args.filename);
  return "anchored";
}
