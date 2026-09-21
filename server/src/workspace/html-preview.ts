import { posix } from "node:path";
import { imageMimeForPath, isHtmlPath } from "../../../shared/filePreview";
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES } from "./file-constants";
import { HtmlPreviewError, type PreviewResource } from "./html-preview-files";

export const HTML_PREVIEW_CSP =
  "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' data: https:; img-src data:; font-src data:";
const MAX_RESOURCES = 64;
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_STYLE_BLOCKS = 256;

export function staticPreviewMime(path: string): string | null {
  if (path.toLowerCase().endsWith(".css")) return "text/css";
  const extension = path.toLowerCase().split(".").pop();
  if (
    extension === "woff" ||
    extension === "woff2" ||
    extension === "ttf" ||
    extension === "otf"
  ) {
    return `font/${extension}`;
  }
  return imageMimeForPath(path);
}

function httpsStylesheetUrl(source: string) {
  const value = source.trim();
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function resourcePath(source: string, documentPath: string) {
  const value = source.trim();
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  )
    return null;
  try {
    const url = new URL(
      value,
      `https://preview.invalid/${documentPath.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (url.origin !== "https://preview.invalid") return null;
    const path = posix.normalize(
      decodeURIComponent(url.pathname).replace(/\\/g, "/"),
    );
    if (path.includes("\0")) return null;
    return path.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

function text(bytes: Buffer) {
  if (bytes.includes(0))
    throw new HtmlPreviewError("HTML preview requires UTF-8 text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HtmlPreviewError("HTML preview requires UTF-8 text");
  }
}

export async function renderHtmlPreview(
  document: PreviewResource,
  readResource: (path: string, limit: number) => Promise<PreviewResource>,
) {
  if (!isHtmlPath(document.path))
    throw new HtmlPreviewError("HTML preview requires an HTML file");
  if (document.bytes.length > PREVIEW_MAX_BYTES)
    throw new HtmlPreviewError("HTML is too large to render", 413);
  const source = text(document.bytes);
  const resources = new Map<string, Promise<PreviewResource | null>>();
  let totalBytes = 0;
  let styleBlocks = 0;
  let embeddedBytes = 0;
  // ponytail: serialize per-preview reads; batch SSH reads if latency warrants it.
  let readTail: Promise<unknown> = Promise.resolve();
  const embedded = (value: string) => {
    embeddedBytes += Buffer.byteLength(value);
    if (embeddedBytes > MAX_RESOURCE_BYTES * 2)
      throw new HtmlPreviewError("HTML preview output is too large", 413);
    return value;
  };
  const read = (path: string) => {
    const cached = resources.get(path);
    if (cached) return cached;
    if (resources.size >= MAX_RESOURCES)
      throw new HtmlPreviewError("HTML preview has too many resources", 413);
    const mime = staticPreviewMime(path);
    if (!mime) return Promise.resolve(null);
    const promise = readTail
      .then(async () => {
        const remaining = MAX_RESOURCE_BYTES - totalBytes;
        if (remaining <= 0)
          throw new HtmlPreviewError(
            "HTML preview resources are too large",
            413,
          );
        const resource = await readResource(
          path,
          Math.min(
            mime === "text/css" ? PREVIEW_MAX_BYTES : PREVIEW_IMAGE_MAX_BYTES,
            remaining,
          ),
        );
        totalBytes += resource.bytes.length;
        if (totalBytes > MAX_RESOURCE_BYTES)
          throw new HtmlPreviewError(
            "HTML preview resources are too large",
            413,
          );
        return staticPreviewMime(resource.path) === mime ? resource : null;
      })
      .catch((error) => {
        if (error instanceof HtmlPreviewError && error.status === 413)
          throw error;
        return null;
      });
    resources.set(path, promise);
    readTail = promise.catch(() => undefined);
    return promise;
  };
  const assetUrl = async (value: string, path: string) => {
    if (/^data:/i.test(value.trim()) || value.trim().startsWith("#"))
      return value;
    const target = resourcePath(value, path);
    const mime = target && staticPreviewMime(target);
    if (!target || !mime || mime === "text/css") return "data:,";
    const resource = await read(target);
    return resource
      ? embedded(`data:${mime};base64,${resource.bytes.toString("base64")}`)
      : "data:,";
  };
  const css = async (contents: string, path: string) => {
    if (!/url|image-set|@import/i.test(contents) && !contents.includes("\\"))
      return contents;
    if (++styleBlocks > MAX_STYLE_BLOCKS)
      throw new HtmlPreviewError("HTML preview has too many style blocks", 413);
    const resolvedPaths = new Map<string, string>();
    let resourceError: unknown;
    const result = await Bun.build({
      entrypoints: ["preview.css"],
      target: "browser",
      minify: true,
      plugins: [
        {
          name: "workspace-preview-css",
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (args.kind === "entry-point-build")
                return { path, namespace: "preview-css" };
              const importer =
                resolvedPaths.get(args.importer) ?? args.importer;
              if (args.kind === "import-rule") {
                const external = httpsStylesheetUrl(args.path);
                if (external) return { path: external, external: true };
                const target = resourcePath(args.path, importer);
                if (!target || staticPreviewMime(target) !== "text/css")
                  return { path: "data:text/css,", external: true };
                return { path: target, namespace: "preview-css" };
              }
              try {
                return {
                  path: await assetUrl(args.path, importer),
                  external: true,
                };
              } catch (error) {
                resourceError = error;
                throw error;
              }
            });
            build.onLoad(
              { filter: /.*/, namespace: "preview-css" },
              async (args) => {
                if (args.path === path) return { contents, loader: "css" };
                try {
                  const resource = await read(args.path);
                  if (resource) resolvedPaths.set(args.path, resource.path);
                  return {
                    contents: resource ? text(resource.bytes) : "",
                    loader: "css",
                  };
                } catch (error) {
                  resourceError = error;
                  throw error;
                }
              },
            );
          },
        },
      ],
    });
    if (resourceError) throw resourceError;
    if (!result.success)
      throw new HtmlPreviewError("Unable to prepare HTML preview styles");
    return embedded(result.outputs[0] ? await result.outputs[0].text() : "");
  };
  const srcset = async (value: string) => {
    const candidates: string[] = [];
    let rest = value;
    while (rest.trim()) {
      rest = rest.replace(/^[\s,]+/, "");
      const match = /^\S+/.exec(rest);
      if (!match) break;
      const url = match[0];
      rest = rest.slice(url.length);
      let descriptor = "";
      if (!url.endsWith(",")) {
        const end = rest.indexOf(",");
        descriptor = (end < 0 ? rest : rest.slice(0, end)).trim();
        rest = end < 0 ? "" : rest.slice(end + 1);
      }
      if (descriptor && !/^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor))
        continue;
      candidates.push(
        `${await assetUrl(url.replace(/,+$/, ""), document.path)} ${descriptor}`.trim(),
      );
    }
    return candidates.join(", ");
  };
  let styleText = "";
  const rewriter = new HTMLRewriter()
    .on("base, script", {
      element(element) {
        element.remove();
      },
    })
    .on("meta[name]", {
      element(element) {
        if (element.getAttribute("name")?.toLowerCase() === "referrer")
          element.remove();
      },
    })
    .on("link", {
      async element(element) {
        if (
          !(element.getAttribute("rel") ?? "")
            .toLowerCase()
            .split(/\s+/)
            .includes("stylesheet")
        ) {
          element.remove();
          return;
        }
        const href = element.getAttribute("href") ?? "";
        element.setAttribute("referrerpolicy", "no-referrer");
        const external = httpsStylesheetUrl(href);
        if (external) {
          element.setAttribute("href", external);
          return;
        }
        const path = resourcePath(href, document.path);
        if (!path || staticPreviewMime(path) !== "text/css") {
          element.remove();
          return;
        }
        const resource = await read(path);
        if (!resource) {
          element.remove();
          return;
        }
        const bundled = await css(text(resource.bytes), resource.path);
        element.setAttribute(
          "href",
          embedded(
            `data:text/css;base64,${Buffer.from(bundled).toString("base64")}`,
          ),
        );
        element.removeAttribute("integrity");
        element.removeAttribute("crossorigin");
      },
    })
    .on("img, source, image, input[type=image]", {
      async element(element) {
        for (const attribute of ["src", "href", "xlink:href"]) {
          const value = element.getAttribute(attribute);
          if (value !== null)
            element.setAttribute(
              attribute,
              await assetUrl(value, document.path),
            );
        }
        const value = element.getAttribute("srcset");
        if (value !== null) element.setAttribute("srcset", await srcset(value));
      },
    })
    .on("[style]", {
      async element(element) {
        const bundled = await css(
          `x{${element.getAttribute("style") ?? ""}}`,
          `${document.path}.css`,
        );
        element.setAttribute(
          "style",
          bundled.slice(bundled.indexOf("{") + 1, bundled.lastIndexOf("}")),
        );
      },
    })
    .on("style", {
      element() {
        styleText = "";
      },
      async text(chunk) {
        styleText += chunk.text;
        if (chunk.lastInTextNode) {
          const bundled = await css(styleText, `${document.path}.css`);
          chunk.replace(bundled.replace(/<\/style/gi, "\\3c /style"), {
            html: true,
          });
        } else {
          chunk.remove();
        }
      },
    });
  const html = await rewriter.transform(new Response(source)).text();
  if (Buffer.byteLength(html) > MAX_RESOURCE_BYTES * 2)
    throw new HtmlPreviewError("HTML preview output is too large", 413);
  return html;
}
