import defaultManifest from "../../../web/public/manifest.json";
import { instanceDisplayName } from "../../../shared/instanceName";
import { join } from "node:path";
import {
  decodeStaticPathname,
  isStaticRequestMethod,
  resolvePublicFilePath,
  shouldServeSpaEntry,
} from "./static-paths";

// --asset ./public preserves this directory under import.meta.dir in binaries.
const builtPublicDir = Bun.isStandaloneExecutable
  ? join(import.meta.dir, "public")
  : join(import.meta.dir, "../../public");

export async function serveStatic(
  req: Request,
  publicDir: string,
  titleSuffix = "",
): Promise<Response> {
  if (!isStaticRequestMethod(req.method)) {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  let pathname: string | null;
  try {
    pathname = decodeStaticPathname(new URL(req.url).pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!pathname) return new Response("bad request", { status: 400 });

  const serveEntry =
    pathname !== "/manifest.json" &&
    (pathname === "/index.html" ||
      shouldServeSpaEntry(req.method, req.headers.get("accept")));

  for (const directory of [publicDir, builtPublicDir]) {
    const filePath = resolvePublicFilePath(directory, pathname);
    if (!filePath) return new Response("not found", { status: 404 });
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return serveFile(req, file, pathname, titleSuffix);
    }
    if (serveEntry) {
      const index = Bun.file(join(directory, "index.html"));
      if (await index.exists()) {
        return serveFile(req, index, "/index.html", titleSuffix);
      }
    }
  }

  // Vite serves source assets before the first build, but proxies this dynamic
  // metadata route to the bridge. Keep the default manifest available then too.
  if (pathname === "/manifest.json") {
    return serveManifest(req, defaultManifest, titleSuffix);
  }
  return new Response("not found", { status: 404 });
}

function serveManifest(
  req: Request,
  manifest: Record<string, unknown>,
  titleSuffix: string,
): Response {
  const headers = responseHeaders("/manifest.json");
  if (req.method === "HEAD") return new Response(null, { headers });
  const name = instanceDisplayName(titleSuffix);
  return Response.json({ ...manifest, name, short_name: name }, { headers });
}

async function serveFile(
  req: Request,
  file: ReturnType<typeof Bun.file>,
  pathname: string,
  titleSuffix: string,
): Promise<Response> {
  const headers = responseHeaders(pathname);
  if (req.method === "HEAD") return new Response(null, { headers });
  if (pathname === "/manifest.json") {
    return serveManifest(req, await file.json(), titleSuffix);
  }
  const response = new Response(file, { headers });
  if (pathname !== "/index.html") return response;
  const name = instanceDisplayName(titleSuffix);
  // HTMLRewriter escapes text and attribute values rather than interpolating
  // the configured name into HTML. The same name is used by the manifest.
  return new HTMLRewriter()
    .on("title", {
      element: (element) => {
        element.setInnerContent(name);
      },
    })
    .on(
      'meta[name="apple-mobile-web-app-title"], meta[name="application-name"]',
      {
        element: (element) => {
          element.setAttribute("content", name);
        },
      },
    )
    .transform(response);
}

function responseHeaders(pathname: string): Record<string, string> {
  const headers = { "content-type": contentType(pathname) };
  if (pathname === "/index.html" || pathname === "/manifest.json") {
    return {
      ...headers,
      // Revalidate both install metadata and the entry document after a name
      // change or update. Shared caches must not reuse authenticated responses.
      "cache-control": "private, no-cache, must-revalidate",
    };
  }
  return headers;
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".json") || pathname.endsWith(".map")) {
    return "application/json; charset=utf-8";
  }
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  if (pathname.endsWith(".woff")) return "font/woff";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
