import { BinReader } from "./bincode";
import type { EndpointSurface, PaneSurfacePaneMeta } from "./endpoint-client";
import { readCellData, type CellData, type FrameData } from "./thin-client";

export const SURFACE_DELTA_KIND = "endpoint.surface-delta.v1";
export const SURFACE_REUSE_KIND = "endpoint.surface-reuse.v1";
const MAX_FRAME = 32 * 1024 * 1024;

/** Cells-or-percent popup sizing, mirroring Herdr's ClientShellPopupSize. */
export type PopupSize = { kind: "cells" | "percent"; value: number } | null;
export type Popup = {
  terminalId: string;
  title: string;
  width: PopupSize;
  height: PopupSize;
  frame: FrameData;
};
export type SurfaceBaseline = EndpointSurface & {
  bootId: string;
  projectionRevision: number;
  popup: Popup | null;
};

function requireSurface(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Invalid endpoint surface: ${reason}`);
}

function uint(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  requireSurface(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= max,
    "integer out of range",
  );
  return value;
}

// Strict reads are local to the endpoint surface codecs. Counts are checked
// before allocation; the frozen legacy thin-client codecs remain unchanged.
export class SurfaceReader extends BinReader {
  override bool(): boolean {
    const value = this.u8();
    requireSurface(value <= 1, "invalid boolean");
    return value === 1;
  }
  override option<T>(read: () => T): T | null {
    return this.bool() ? read() : null;
  }
  number(max = Number.MAX_SAFE_INTEGER) {
    return uint(this.varint(), max);
  }
  count(max: number) {
    return this.number(Math.min(max, this.remaining));
  }
}

function readCursor(r: SurfaceReader): FrameData["cursor"] {
  return r.option(() => ({
    x: r.number(65535),
    y: r.number(65535),
    visible: r.bool(),
    shape: r.u8(),
  }));
}

function readCells(r: SurfaceReader, count: number): CellData[] {
  requireSurface(count <= Math.floor(r.remaining / 6), "truncated cells");
  return Array.from({ length: count }, () => {
    const cell = readCellData(r);
    uint(cell.fg, 0xffffffff);
    uint(cell.bg, 0xffffffff);
    uint(cell.modifier, 65535);
    if (cell.hyperlink !== null) uint(cell.hyperlink, 0xffffffff);
    return cell;
  });
}

function readFrame(r: SurfaceReader, metadata = false): FrameData {
  const count = r.count(metadata ? 0 : Math.floor(MAX_FRAME / 6));
  const cells = readCells(r, count);
  const width = r.number(metadata ? 4096 : 65535);
  const height = r.number(metadata ? 4096 : 65535);
  requireSurface(
    metadata ? width * height <= 1_000_000 : count === width * height,
    "invalid grid size",
  );
  const cursor = readCursor(r);
  const hyperlinks = Array.from(
    { length: r.count(metadata ? 65536 : MAX_FRAME) },
    () => r.string(),
  );
  r.bytes(); // Kitty graphics bytes are not rendered by the pane terminal.
  return { cells, width, height, cursor, hyperlinks };
}

function readRect(r: SurfaceReader) {
  return {
    x: r.number(65535),
    y: r.number(65535),
    width: r.number(65535),
    height: r.number(65535),
  };
}

function readPanes(r: SurfaceReader, metadata = false): PaneSurfacePaneMeta[] {
  const panes = Array.from(
    { length: r.count(metadata ? 4096 : Math.floor(r.remaining / 18)) },
    () => {
      const paneId = r.string();
      const contentRevision = r.number();
      const rect = readRect(r);
      const innerRect = readRect(r);
      r.option(() => readRect(r));
      const scroll = r.option(() => ({
        offsetFromBottom: r.number(),
        maxOffsetFromBottom: r.number(),
        viewportRows: r.number(),
      }));
      const focused = r.bool();
      const mouseReporting = r.bool();
      r.bool(); // sgr_pixel_mouse
      r.bool(); // alternate_screen_active
      r.number(0xffffffff); // pixel_width
      r.number(0xffffffff); // pixel_height
      return {
        paneId,
        contentRevision,
        rect,
        innerRect,
        scroll,
        focused,
        mouseReporting,
      };
    },
  );
  requireSurface(
    new Set(panes.map((p) => p.paneId)).size === panes.length,
    "duplicate panes",
  );
  return panes;
}

/** Same two fields the surface has always carried, now kept: a popup is
 * presented with its own title and requested size. */
function readPopupSize(r: SurfaceReader): PopupSize {
  return r.option(() =>
    r.number(1) === 0
      ? { kind: "cells" as const, value: r.number(65535) }
      : { kind: "percent" as const, value: r.u8() },
  );
}

function readPopup(r: SurfaceReader, metadata: boolean): Popup | null {
  return r.option(() => {
    const terminalId = r.string();
    const title = r.string();
    const width = readPopupSize(r);
    const height = readPopupSize(r);
    const frame = readFrame(r, metadata);
    r.bool();
    r.bool();
    r.number(0xffffffff);
    r.number(0xffffffff);
    return { terminalId, title, width, height, frame };
  });
}

// The scene precedes delta rows on the wire even though Roamgate does not
// render it. Consume every field, without retaining image payloads.
function skipGraphicsKey(r: SurfaceReader) {
  if (r.number(1) === 0) {
    r.number(1); // Pane / Popup target
    r.string();
    r.number(0xffffffff); // image_id
  } else {
    r.string();
    r.string();
  }
  r.number(0xffffffff);
  r.number(0xffffffff);
  r.number(2); // RGB / RGBA / PNG
  r.varint(); // data_len
  r.varint(); // opaque u64 fingerprint, never compared as a JS number
}

function skipGraphics(r: SurfaceReader, metadata: boolean): boolean {
  const assets = r.count(metadata ? 4096 : MAX_FRAME);
  for (let i = 0; i < assets; i++) {
    skipGraphicsKey(r);
    r.bytes();
  }
  const placements = r.count(metadata ? 65536 : MAX_FRAME);
  for (let i = 0; i < placements; i++) {
    skipGraphicsKey(r);
    // logical id, x/y, cols/rows, source rect, offsets, zigzag z, scrollback
    for (let j = 0; j < 13; j++) r.number(0xffffffff);
  }
  const retained = r.count(metadata ? 65536 : MAX_FRAME);
  for (let i = 0; i < retained; i++) skipGraphicsKey(r);
  return assets + placements + retained > 0;
}

function readSurface(r: SurfaceReader, metadata: boolean) {
  const bootId = r.string();
  const projectionRevision = r.number();
  const surfaceRevision = r.number();
  const frame = readFrame(r, metadata);
  const panes = readPanes(r, metadata);
  const splits = r.count(metadata ? 4096 : Math.floor(r.remaining / 11));
  for (let i = 0; i < splits; i++) {
    r.number(1);
    r.number(65535);
    readRect(r);
    readRect(r);
    const count = r.count(metadata ? 4096 : MAX_FRAME);
    for (let j = 0; j < count; j++) r.bool();
  }
  const popup = readPopup(r, metadata);
  const hasGraphics = skipGraphics(r, metadata);
  return {
    surface: {
      bootId,
      projectionRevision,
      surfaceRevision,
      frame,
      panes,
      popup,
    },
    hasGraphics,
  };
}

function validateLinks(frame: FrameData) {
  requireSurface(
    frame.cells.every(
      (c) =>
        c.hyperlink === null ||
        (Number.isSafeInteger(c.hyperlink) &&
          c.hyperlink >= 0 &&
          c.hyperlink < frame.hyperlinks.length),
    ),
    "invalid hyperlink index",
  );
}

export function readFullSurface(r: SurfaceReader): SurfaceBaseline {
  const { surface } = readSurface(r, false);
  requireSurface(r.remaining === 0, "trailing full-frame bytes");
  validateLinks(surface.frame);
  if (surface.popup) validateLinks(surface.popup.frame);
  return surface;
}

function checkBase(
  current: SurfaceBaseline | null,
  bootId: string,
  base: number,
  next: number,
): asserts current is SurfaceBaseline {
  requireSurface(
    current &&
      current.bootId === bootId &&
      current.surfaceRevision === base &&
      next === base + 1,
    "baseline mismatch; reconnect required",
  );
}

function patchCells(
  r: SurfaceReader,
  frame: FrameData,
  sparse: boolean,
): CellData[] {
  const count = r.count(
    sparse ? Math.min(4096, frame.width * frame.height) : MAX_FRAME,
  );
  const cells = frame.cells.slice();
  let previousEnd = 0;
  for (let i = 0; i < count; i++) {
    const x = r.number(65535);
    const y = r.number(65535);
    const length = r.count(frame.width);
    const start = y * frame.width + x;
    requireSurface(
      y < frame.height &&
        x + length <= frame.width &&
        (!sparse || (length > 0 && start >= previousEnd)),
      "span outside grid or overlapping",
    );
    const row = readCells(r, length);
    for (let j = 0; j < length; j++) cells[start + j] = row[j];
    previousEnd = start + length;
  }
  return cells;
}

export function readSurfacePatch(
  r: SurfaceReader,
  current: SurfaceBaseline | null,
): SurfaceBaseline {
  const bootId = r.string();
  const projectionRevision = r.number();
  const base = r.number();
  const surfaceRevision = r.number();
  checkBase(current, bootId, base, surfaceRevision);
  requireSurface(
    projectionRevision === current.projectionRevision,
    "patch projection mismatch",
  );
  const cells = patchCells(r, current.frame, false);
  const panes = current.panes.slice();
  for (const pane of readPanes(r)) {
    const index = panes.findIndex((p) => p.paneId === pane.paneId);
    requireSurface(index >= 0, "patch changes pane topology");
    panes[index] = pane;
  }
  const frame = { ...current.frame, cells, cursor: readCursor(r) };
  requireSurface(r.remaining === 0, "trailing patch bytes");
  validateLinks(frame);
  return { ...current, surfaceRevision, frame, panes };
}

export function readSurfaceDelta(
  data: string,
  current: SurfaceBaseline | null,
): SurfaceBaseline {
  requireSurface(
    data.length <= MAX_FRAME && /^[A-Za-z0-9+/]*$/.test(data),
    "invalid delta base64",
  );
  const bytes = Buffer.from(data, "base64");
  requireSurface(
    bytes.toString("base64").replace(/=+$/, "") === data,
    "invalid delta base64",
  );
  const r = new SurfaceReader(bytes);
  const baseProjection = r.number();
  const base = r.number();
  const { surface, hasGraphics } = readSurface(r, true);
  requireSurface(
    hasGraphics || data.length <= 2 * 1024 * 1024,
    "ordinary delta exceeds frame limit",
  );
  checkBase(current, surface.bootId, base, surface.surfaceRevision);
  requireSurface(
    baseProjection === current.projectionRevision &&
      surface.projectionRevision >= baseProjection,
    "delta projection mismatch",
  );
  requireSurface(
    surface.frame.width === current.frame.width &&
      surface.frame.height === current.frame.height,
    "delta dimensions changed",
  );
  surface.frame.cells = patchCells(
    r,
    { ...surface.frame, cells: current.frame.cells },
    true,
  );
  const hasPopupUpdate = r.bool();
  requireSurface(
    hasPopupUpdate === (surface.popup !== null),
    "missing or unexpected popup update",
  );
  if (surface.popup) {
    const popup = surface.popup;
    if (r.number(1) === 0) {
      const previous = current.popup;
      requireSurface(
        previous &&
          previous.terminalId === popup.terminalId &&
          previous.frame.width === popup.frame.width &&
          previous.frame.height === popup.frame.height,
        "popup baseline mismatch",
      );
      popup.frame.cells = patchCells(
        r,
        { ...popup.frame, cells: previous.frame.cells },
        true,
      );
    } else {
      const count = r.count(1_000_000);
      requireSurface(
        count === popup.frame.width * popup.frame.height,
        "popup replacement size mismatch",
      );
      popup.frame.cells = readCells(r, count);
    }
    validateLinks(popup.frame);
  }
  requireSurface(r.remaining === 0, "trailing delta bytes");
  validateLinks(surface.frame);
  return surface;
}

function object(value: unknown): Record<string, unknown> {
  requireSurface(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected object",
  );
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  requireSurface(typeof value === "string", "expected string");
  return value;
}
function bool(value: unknown): boolean {
  requireSurface(typeof value === "boolean", "expected boolean");
  return value;
}
function array(value: unknown, max: number): unknown[] {
  requireSurface(
    Array.isArray(value) && value.length <= max,
    "invalid collection",
  );
  return value;
}
function rect(value: unknown) {
  const v = object(value);
  return {
    x: uint(v.x, 65535),
    y: uint(v.y, 65535),
    width: uint(v.width, 65535),
    height: uint(v.height, 65535),
  };
}

export function readSurfaceReuse(
  data: string,
  current: SurfaceBaseline | null,
): SurfaceBaseline {
  requireSurface(
    Buffer.byteLength(data) <= 2 * 1024 * 1024,
    "reuse exceeds frame limit",
  );
  const reuse = object(JSON.parse(data));
  const raw = object(reuse.surface);
  const bootId = string(raw.boot_id);
  const projectionRevision = uint(raw.projection_revision);
  const surfaceRevision = uint(raw.surface_revision);
  checkBase(
    current,
    bootId,
    uint(reuse.base_surface_revision),
    surfaceRevision,
  );
  requireSurface(
    projectionRevision >= current.projectionRevision,
    "reuse projection mismatch",
  );
  const f = object(raw.frame);
  requireSurface(
    array(f.cells, 0).length === 0 &&
      uint(f.width, 65535) === current.frame.width &&
      uint(f.height, 65535) === current.frame.height,
    "reuse grid mismatch",
  );
  const c = f.cursor === null ? null : object(f.cursor);
  const frame: FrameData = {
    cells: current.frame.cells,
    width: current.frame.width,
    height: current.frame.height,
    cursor: c && {
      x: uint(c.x, 65535),
      y: uint(c.y, 65535),
      visible: bool(c.visible),
      shape: uint(c.shape, 255),
    },
    hyperlinks: array(f.hyperlinks, 65536).map(string),
  };
  // v1 reuse is sent only without a popup; popup grids use the binary codec.
  requireSurface(raw.popup === null, "unexpected reuse popup");
  const panes = array(raw.panes, 4096).map((value) => {
    const p = object(value);
    const s = p.scroll === null ? null : object(p.scroll);
    return {
      paneId: string(p.pane_id),
      contentRevision: uint(p.content_revision),
      rect: rect(p.rect),
      innerRect: rect(p.inner_rect),
      scroll: s && {
        offsetFromBottom: uint(s.offset_from_bottom),
        maxOffsetFromBottom: uint(s.max_offset_from_bottom),
        viewportRows: uint(s.viewport_rows),
      },
      focused: bool(p.focused),
      mouseReporting: bool(p.mouse_reporting),
    };
  });
  requireSurface(
    new Set(panes.map((p) => p.paneId)).size === panes.length,
    "duplicate panes",
  );
  validateLinks(frame);
  return {
    bootId,
    projectionRevision,
    surfaceRevision,
    frame,
    panes,
    popup: null,
  };
}
