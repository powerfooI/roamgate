import { resolveWorkspaceMarkdownLink } from "../workspaceFileUrl";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { marked } from "marked";
import { lazyWithReload } from "../lazyWithReload";
import "./markdown.css";
const MermaidDiagram = lazyWithReload("mermaid-preview", () =>
  import("./MermaidDiagram").then((module) => ({
    default: module.MermaidDiagram,
  })),
);

const MARKDOWN_ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const MARKDOWN_ALLOWED_ATTRS = new Set([
  "alt",
  "checked",
  "colspan",
  "disabled",
  "href",
  "rowspan",
  "src",
  "title",
  "type",
]);
const MARKDOWN_DROP_CONTENT_TAGS = new Set([
  "iframe",
  "object",
  "script",
  "style",
]);

export function isSafeMarkdownUrl(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/);
  if (!protocolMatch) return true;
  return ["http:", "https:", "mailto:"].includes(protocolMatch[0]);
}

type MarkdownRenderOptions = {
  breaks?: boolean;
  imageUrlResolver?: (source: string) => string | null;
  documentPath?: string;
  linkUrlResolver?: (path: string) => string;
};

export type MarkdownSelectionTarget = {
  quote: string;
  section: string[];
  x: number;
  y: number;
};

function selectionElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

export function markdownHeadingPath(root: Element, node: Node): string[] {
  const target = selectionElement(node);
  if (!target || !root.contains(target)) return [];
  const path: string[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>(
    "h1, h2, h3, h4, h5, h6",
  )) {
    const beforeTarget =
      heading === target ||
      heading.contains(target) ||
      Boolean(
        heading.compareDocumentPosition(target) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    if (!beforeTarget) break;
    const level = Number(heading.tagName.slice(1));
    path.length = Math.min(path.length, level - 1);
    path[level - 1] = heading.textContent?.trim() ?? "";
  }
  return path.filter(Boolean);
}

export function markdownSelectionTarget(
  root: HTMLElement,
  selection: Selection | null = window.getSelection(),
): MarkdownSelectionTarget | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const start = selectionElement(range.startContainer);
  const end = selectionElement(range.endContainer);
  if (!start || !end || !root.contains(start) || !root.contains(end)) {
    return null;
  }
  if (start.closest(".mermaid-diagram") || end.closest(".mermaid-diagram")) {
    return null;
  }
  const quote = selection
    .toString()
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!quote || quote.length > 20_000) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    quote,
    section: markdownHeadingPath(root, range.startContainer),
    x: rect.left,
    y: rect.bottom + 6,
  };
}

export function sanitizeMarkdownHtml(
  html: string,
  options: MarkdownRenderOptions = {},
) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (MARKDOWN_DROP_CONTENT_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!MARKDOWN_ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    if (tag === "input") {
      const isCheckbox = element.getAttribute("type") === "checkbox";
      if (!isCheckbox) {
        element.remove();
        continue;
      }
      element.setAttribute("disabled", "");
    }

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name === "class" &&
        tag === "code" &&
        /^language-[a-z0-9#+.-]{1,40}$/i.test(attr.value.trim())
      ) {
        // Keep the fenced-code language hint so mermaid blocks can be found
        // and replaced with rendered diagrams after sanitization.
        continue;
      }
      if (
        name.startsWith("on") ||
        name === "style" ||
        !MARKDOWN_ALLOWED_ATTRS.has(name)
      ) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" || name === "src") {
        if (!isSafeMarkdownUrl(attr.value)) {
          element.removeAttribute(attr.name);
          continue;
        }
        if (name === "src" && tag === "img" && options.imageUrlResolver) {
          const resolved = options.imageUrlResolver(attr.value);
          if (!resolved || !isSafeMarkdownUrl(resolved)) {
            element.removeAttribute(attr.name);
          } else {
            element.setAttribute(attr.name, resolved);
          }
        }
      }
    }

    if (tag === "a" && element.hasAttribute("href")) {
      const href = element.getAttribute("href")!;
      const destination = options.documentPath
        ? resolveWorkspaceMarkdownLink(href, options.documentPath)
        : undefined;
      if (destination === null) {
        element.removeAttribute("href");
      } else if (destination) {
        element.setAttribute("data-document-path", destination.path);
        element.setAttribute("data-document-fragment", destination.fragment);
        element.setAttribute(
          "href",
          options.linkUrlResolver?.(destination.path) ?? "#",
        );
      } else if (!href.startsWith("#")) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
      }
    }
  }

  const headingIds = new Set<string>();
  for (const heading of doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const base = (heading.textContent ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    let id = base;
    let suffix = 0;
    while (headingIds.has(id)) id = `${base}-${++suffix}`;
    headingIds.add(id);
    heading.setAttribute("id", id);
  }
  return doc.body.innerHTML;
}

export function renderMarkdown(
  text: string,
  options: MarkdownRenderOptions = {},
) {
  const html = marked.parse(text, {
    async: false,
    // Chat messages are not authored as strict markdown documents, so callers
    // rendering conversation text should opt into breaks to keep intentional
    // single newlines instead of collapsing them into one paragraph.
    breaks: options.breaks ?? false,
    gfm: true,
  });
  return sanitizeMarkdownHtml(String(html), options);
}

export function MarkdownPreview({
  text,
  className = "",
  breaks = false,
  imageUrlResolver,
  documentPath,
  linkUrlResolver,
  onOpenDocument,
  fragment,
  onSelectionChange,
}: {
  text: string;
  className?: string;
  breaks?: boolean;
  imageUrlResolver?: (source: string) => string | null;
  documentPath?: string;
  linkUrlResolver?: (path: string) => string;
  onOpenDocument?: (path: string, fragment: string) => void;
  fragment?: string;
  onSelectionChange?: (target: MarkdownSelectionTarget | null) => void;
}) {
  const html = useMemo(
    () =>
      renderMarkdown(text, {
        breaks,
        imageUrlResolver,
        documentPath,
        linkUrlResolver,
      }),
    [text, breaks, imageUrlResolver, documentPath, linkUrlResolver],
  );
  const articleRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (fragment) scrollToMarkdownHeading(articleRef.current, fragment);
  }, [html, fragment]);

  const openLink = (event: React.MouseEvent<HTMLElement>) => {
    const target =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (!target || !event.currentTarget.contains(target)) return;
    const path = target.getAttribute("data-document-path");
    if (path && onOpenDocument) {
      event.preventDefault();
      const anchor = target.getAttribute("data-document-fragment") ?? "";
      if (path === documentPath) {
        if (anchor) scrollToMarkdownHeading(articleRef.current, anchor);
        else articleRef.current?.scrollIntoView({ block: "start" });
      } else onOpenDocument(path, anchor);
    } else if (target.getAttribute("href")?.startsWith("#")) {
      event.preventDefault();
      const hash = target.getAttribute("href")!.slice(1);
      let anchor = hash;
      try {
        anchor = decodeURIComponent(hash);
      } catch {
        /* Keep malformed fragments literal. */
      }
      scrollToMarkdownHeading(articleRef.current, anchor);
    }
  };

  const [diagrams, setDiagrams] = useState<
    Array<{ target: HTMLElement; code: string }>
  >([]);
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const diagrams: Array<{ target: HTMLElement; code: string }> = [];
    const originals: Array<{ target: HTMLElement; pre: HTMLElement }> = [];
    for (const code of root.querySelectorAll("pre > code.language-mermaid")) {
      const pre = code.parentElement;
      if (!pre) continue;
      const target = document.createElement("div");
      target.className = "markdown-mermaid-slot";
      pre.replaceWith(target);
      originals.push({ target, pre });
      diagrams.push({ target, code: code.textContent ?? "" });
    }
    setDiagrams(diagrams);
    return () => {
      // Restore the sanitized code blocks for StrictMode's effect replay.
      // On navigation the article's new HTML already owns different nodes.
      for (const { target, pre } of originals) {
        if (root.contains(target)) target.replaceWith(pre);
      }
    };
  }, [html]);

  useEffect(() => {
    if (!onSelectionChange) return;
    let frame = 0;
    const updateSelection = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = articleRef.current;
        onSelectionChange(root ? markdownSelectionTarget(root) : null);
      });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", updateSelection);
    };
  }, [onSelectionChange]);

  return (
    <>
      <article
        ref={articleRef}
        onClick={openLink}
        onAuxClick={(event) => {
          if (event.button === 1) openLink(event);
        }}
        className={`file-preview-markdown ${className}`.trim()}
        onPointerDown={() => onSelectionChange?.(null)}
        onPointerUp={() => {
          requestAnimationFrame(() => {
            const root = articleRef.current;
            onSelectionChange?.(root ? markdownSelectionTarget(root) : null);
          });
        }}
        onKeyUp={() => {
          const root = articleRef.current;
          onSelectionChange?.(root ? markdownSelectionTarget(root) : null);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {diagrams.map(({ target, code }, index) =>
        createPortal(
          <Suspense
            fallback={
              <div className="file-preview-state" role="status">
                Rendering diagram
              </div>
            }
          >
            <MermaidDiagram code={code} />
          </Suspense>,
          target,
          String(index),
        ),
      )}
    </>
  );
}

function scrollToMarkdownHeading(root: HTMLElement | null, fragment: string) {
  const heading = Array.from(
    root?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [],
  ).find((element) => element.id === fragment);
  heading?.scrollIntoView({ block: "start" });
}
