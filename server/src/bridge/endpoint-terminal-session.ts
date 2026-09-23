import { EventEmitter } from "node:events";
import { EndpointClient, type EndpointSurface } from "./endpoint-client";
import { EndpointCreationDeadline } from "./endpoint-creation";
import { frameToAnsi } from "./frame-to-ansi";
import type { FrameData } from "./thin-client";
import type { Logger } from "../utils/logger";
import { silentLogger } from "../utils/logger";
import { MOUSE_KIND, VtInputClassifier } from "./vt-input-classifier";

const ESC_FLUSH_MS = 25;
const FIRST_SURFACE_WAIT_MS = 10_000;
// Boot correction plus rounding follow-ups; nested splits can need three.
const SURFACE_FIT_MAX_ATTEMPTS = 3;
// How long a misfitting frame waits for the settled replacement.
const FIT_DEFER_MS = 500;

type ScrollDispatch = {
  offset: number;
  startOffset: number;
  observed: boolean;
};

/**
 * Terminal stream over the stable endpoint protocol (Herdr >= 0.9.0).
 *
 * The endpoint shell renders the focused tab, so this session focuses the
 * pane (which focuses its tab for this shell connection only) and crops the
 * tab surface down to the pane's content rect before re-encoding to ANSI.
 *
 * Members intentionally mirror the ThinClient surface the terminal bridge
 * uses (isClosed/connecting/resize/input/scroll/close/events) so the bridge
 * can hold either backend in one field.
 */
export class EndpointTerminalSession extends EventEmitter {
  private client: EndpointClient;
  private classifier = new VtInputClassifier();
  private pressedMouseButtons = new Set<number>();
  private escFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private paneId: string | null = null;
  private lastScroll: {
    offsetFromBottom: number;
    maxOffsetFromBottom: number;
  } | null = null;
  // Keep wheel intent separate from viewport feedback: a delayed surface must
  // not replace movement already queued by newer wheel events.
  private scrollTarget: number | null = null;
  private scrollInFlight = false;
  // One dispatch waits for both its RPC and viewport feedback. Further wheel
  // events coalesce into scrollTarget without blocking the shared command lane.
  private scrollDispatched: ScrollDispatch | null = null;
  private closed = false;
  private seq = 0;
  private readonly linkSessionId = crypto.randomUUID();
  private linkLookupEpoch = 0;
  private linkFrame: {
    token: string;
    content: string;
    surface: EndpointSurface;
    frame: FrameData;
  } | null = null;
  private deferredFrame: {
    timer: ReturnType<typeof setTimeout>;
    emit: () => void;
  } | null = null;
  private paneSize = { cols: 0, rows: 0 };
  private fitAttempts = 0;
  private fitResizeInFlight = false;
  private lastRequest = { cols: 0, rows: 0 };
  private commandChain: Promise<unknown> = Promise.resolve();
  connecting: Promise<void> | null = null;

  constructor(
    socketPath: string,
    private terminalId: string,
    private lookupPaneId: (terminalId: string) => Promise<string | null>,
    private logger: Logger = silentLogger,
    private firstSurfaceWaitMs = FIRST_SURFACE_WAIT_MS,
    surfaceCodecsEnabled = true,
  ) {
    super();
    this.client = new EndpointClient(socketPath, surfaceCodecsEnabled);
    this.client.on("surface", (s) => this.onSurface(s));
    this.client.on("clipboard", (clipboard) => {
      if (!this.closed && this.paneId) this.emit("clipboard", clipboard);
    });
    this.client.on("error", (e) => this.emit("error", e));
    this.client.on("close", () => {
      this.close();
      this.emit("close");
    });
    this.client.on("welcome", (w) => {
      this.emit("welcome", {
        version: w.serverVersion,
        encoding: 1,
        error: null,
      });
    });
  }

  get isClosed() {
    return this.closed;
  }

  get negotiation() {
    return this.client.negotiation;
  }

  connect(
    cols: number,
    rows: number,
    surfaceSize = { cols, rows },
  ): Promise<void> {
    this.paneSize = { cols, rows };
    // Browser layout supplies the initial full-tab viewport. Surface
    // feedback still corrects stale hints and clients without layout data.
    this.fitAttempts = SURFACE_FIT_MAX_ATTEMPTS;
    this.lastRequest = surfaceSize;
    const ready = (async () => {
      await this.client.connect(surfaceSize.cols, surfaceSize.rows);
      this.client.assertMethod("pane.focus");
      const paneId = await this.lookupPaneId(this.terminalId);
      if (!paneId) {
        throw new Error(
          `no pane found for terminal ${this.terminalId} (endpoint path)`,
        );
      }
      this.paneId = paneId;
      // Focus scopes this shell's surface to the pane's tab; per-client
      // tab navigation leaves other clients on their own tabs. Same-tab
      // pane focus remains shared and determines which pane has a cursor.
      await this.enqueueCommand(() =>
        this.client.callEndpoint("pane.focus", { pane_id: paneId }),
      );
      // A surface may have arrived before the lookup resolved; process it
      // now if it already contains the pane.
      const current = this.client.currentSurface;
      if (current && this.hasPane(current, paneId)) {
        this.onSurface(current);
      }
      await this.waitForSurface(paneId);
    })();
    this.connecting = ready
      .catch((e) => {
        this.logger.warn("endpoint connect failed", {
          terminal: this.terminalId,
          error: e instanceof Error ? e.message : String(e),
        });
        this.close();
        throw e;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private enqueueCommand<T>(run: () => Promise<T>): Promise<T> {
    const bounded = async () => {
      if (this.closed) throw new Error("Endpoint terminal is closed");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(
                  "Endpoint command timed out; check Herdr before retrying. Creation may have succeeded.",
                ),
              );
              this.close();
            }, 10_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const task = this.commandChain.then(bounded, bounded);
    this.commandChain = task.catch(() => undefined);
    return task;
  }

  /** Select the cursor owner using this shell's scoped endpoint lane. */
  focus(isCurrent: () => boolean): Promise<void> {
    return this.enqueueCommand(async () => {
      if (!isCurrent()) return;
      if (!this.paneId) throw new Error("Endpoint terminal is not ready");
      await this.client.callEndpoint("pane.focus", { pane_id: this.paneId });
    });
  }

  /** Reuse the attached shell/clipboard lane; never refocus it for creation. */
  create(
    method: "tab.create" | "workspace.create",
    params: Record<string, unknown>,
    sourcePaneId: string,
    validateSource: () => Promise<void>,
    deadline = new EndpointCreationDeadline(),
  ): Promise<unknown> {
    return deadline.wait(
      this.enqueueCommand(async () => {
        deadline.assertBeforeDispatch();
        const ready = () =>
          !this.closed &&
          !this.connecting &&
          this.paneId === sourcePaneId &&
          this.hasPane(this.latestSurface(), sourcePaneId);
        if (!ready())
          throw new Error(
            "Source terminal is not ready. Open its tab and retry creation.",
          );
        for (const requiredMethod of ["pane.focus", method]) {
          this.client.assertMethod(requiredMethod);
        }
        await validateSource();
        if (!ready())
          throw new Error(
            "Source terminal changed before creation. Open its tab and retry.",
          );
        return deadline.dispatch(() =>
          this.client.callEndpoint(method, { ...params, focus: false }),
        );
      }),
      () => this.close(),
    );
  }

  private waitForSurface(paneId: string): Promise<void> {
    if (this.hasPane(this.latestSurface(), paneId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`timed out waiting for endpoint surface of ${paneId}`),
        );
      }, this.firstSurfaceWaitMs);
      const onSurface = (s: EndpointSurface) => {
        if (this.hasPane(s, paneId)) {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("endpoint connection closed before first surface"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.client.off("surface", onSurface);
        this.client.off("close", onClose);
      };
      this.client.on("surface", onSurface);
      this.client.on("close", onClose);
    });
  }

  private latestSurface(): EndpointSurface | null {
    return this.client.currentSurface;
  }

  private hasPane(surface: EndpointSurface | null, paneId: string): boolean {
    return surface?.panes.some((p) => p.paneId === paneId) ?? false;
  }

  private onSurface(surface: EndpointSurface) {
    if (this.closed) return;
    if (!this.paneId) return; // connect() replays after lookup
    const pane = surface.panes.find((p) => p.paneId === this.paneId);
    if (!pane?.mouseReporting) this.pressedMouseButtons.clear();
    if (!pane) {
      this.linkFrame = null;
      this.lastScroll = null;
      this.scrollTarget = null;
      this.scrollDispatched = null;
      return;
    }
    this.fitSurface(surface, pane);
    const previousMaxOffset = this.lastScroll?.maxOffsetFromBottom;
    this.lastScroll = pane.scroll
      ? {
          offsetFromBottom: pane.scroll.offsetFromBottom,
          maxOffsetFromBottom: pane.scroll.maxOffsetFromBottom,
        }
      : null;
    if (!this.lastScroll) {
      this.scrollTarget = null;
      this.scrollDispatched = null;
    } else if (this.scrollTarget !== null) {
      const sent = this.scrollDispatched;
      // Rebase only outstanding movement, not a completed dispatch awaiting
      // its frame. Otherwise growth creates a hidden target never sent by RPC.
      if (
        !sent ||
        (this.scrollInFlight && !sent.observed) ||
        this.scrollTarget !== sent.offset
      ) {
        const growth =
          previousMaxOffset === undefined
            ? 0
            : this.lastScroll.maxOffsetFromBottom - previousMaxOffset;
        if (this.scrollTarget > 0) this.scrollTarget += growth;
      }
      this.scrollTarget = Math.max(
        0,
        Math.min(this.lastScroll.maxOffsetFromBottom, this.scrollTarget),
      );
      if (sent)
        sent.offset = Math.min(
          sent.offset,
          this.lastScroll.maxOffsetFromBottom,
        );
      if (
        sent &&
        (this.lastScroll.offsetFromBottom === sent.offset ||
          this.lastScroll.offsetFromBottom !== sent.startOffset)
      ) {
        sent.observed = true;
      }
      this.settleScroll();
    }

    const cropped = cropFrame(surface.frame, pane.innerRect);
    // Herdr emits full surfaces even for focus and read-only link RPCs. Surface
    // sequence/object identity is not link content identity; cursor is not content.
    const content = JSON.stringify({
      paneId: pane.paneId,
      revision: pane.contentRevision,
      rect: pane.innerRect,
      scroll: pane.scroll,
      width: cropped.width,
      height: cropped.height,
      cells: cropped.cells,
      hyperlinks: cropped.hyperlinks,
    });
    if (this.linkFrame?.content !== content) this.linkFrame = null;
    const bytes = Buffer.from(frameToAnsi(cropped), "utf8");
    const mouseReporting = pane.mouseReporting;
    const emitFrame = () => {
      if (this.closed) return;
      this.seq += 1;
      const token =
        this.linkFrame?.token ?? `${this.linkSessionId}:${this.seq}`;
      this.linkFrame ??= { token, content, surface, frame: cropped };
      this.emit("terminal", {
        linkFrame: token,
        seq: this.seq,
        width: cropped.width,
        height: cropped.height,
        full: true,
        mouseReporting,
        history: pane.scroll
          ? {
              revision: pane.contentRevision,
              top:
                pane.scroll.maxOffsetFromBottom - pane.scroll.offsetFromBottom,
              total: pane.scroll.maxOffsetFromBottom + pane.scroll.viewportRows,
              cols: pane.innerRect.width,
              rows: pane.innerRect.height,
            }
          : undefined,
        bytes,
        frame: cropped,
      });
    };
    // Wait for the requested geometry regardless of split ratio. New
    // frames replace the pending payload, never extend its deadline.
    if (this.fitResizeInFlight) {
      if (this.deferredFrame) {
        this.deferredFrame.emit = emitFrame;
      } else {
        const timer = setTimeout(() => {
          const pending = this.deferredFrame;
          if (pending?.timer !== timer) return;
          this.deferredFrame = null;
          this.fitResizeInFlight = false;
          pending.emit();
        }, FIT_DEFER_MS);
        this.deferredFrame = { timer, emit: emitFrame };
      }
      return;
    }
    this.clearDeferredFrame();
    emitFrame();
  }

  private clearDeferredFrame() {
    if (!this.deferredFrame) return;
    clearTimeout(this.deferredFrame.timer);
    this.deferredFrame = null;
  }

  resize(cols: number, rows: number) {
    this.linkFrame = null;
    this.clearDeferredFrame();
    this.paneSize = { cols, rows };
    this.fitAttempts = SURFACE_FIT_MAX_ATTEMPTS;
    const next = this.requestFor(this.latestSurface());
    // Explicit viewer requests include same-size repaints for new viewers.
    this.fitResizeInFlight = true;
    this.lastRequest = next;
    this.client.resize(next.cols, next.rows);
  }

  // The wanted request for the latest observed geometry. The pane ratio
  // inverts the split so the cropped content lands on the xterm size;
  // without any observed pane the pane size itself is the best guess.
  private requestFor(surface: EndpointSurface | null) {
    const pane = surface?.panes.find((p) => p.paneId === this.paneId);
    if (!surface || !pane) return { ...this.paneSize };
    return this.sizeForPane(surface, pane);
  }

  // Endpoint dimensions describe the complete tab, unlike legacy direct
  // terminal attachments. Invert the observed pane ratio, including pane
  // decorations, so the first request already targets the wanted content
  // size instead of converging through visible reflows.
  private sizeForPane(
    surface: EndpointSurface,
    pane: NonNullable<EndpointSurface["panes"][number]>,
  ) {
    if (
      pane.rect.width < 1 ||
      pane.rect.height < 1 ||
      pane.innerRect.width < 1 ||
      pane.innerRect.height < 1
    )
      return { ...this.paneSize };
    const scale = (
      wanted: number,
      outer: number,
      inner: number,
      total: number,
    ) =>
      Math.max(
        1,
        Math.min(
          65_535,
          Math.round(((wanted + outer - inner) * total) / outer),
        ),
      );
    return {
      cols: scale(
        this.paneSize.cols,
        pane.rect.width,
        pane.innerRect.width,
        surface.frame.width,
      ),
      rows: scale(
        this.paneSize.rows,
        pane.rect.height,
        pane.innerRect.height,
        surface.frame.height,
      ),
    };
  }

  // Convergence is content-shaped, not frame-shaped: once the cropped pane
  // content matches the xterm size the viewer sees the right geometry and
  // no further resize may fire, even if the frame is still settling.
  private fitSurface(
    surface: EndpointSurface,
    pane: NonNullable<EndpointSurface["panes"][number]>,
  ) {
    // Only the response to the latest request can settle or correct it.
    if (
      surface.frame.width !== this.lastRequest.cols ||
      surface.frame.height !== this.lastRequest.rows
    )
      return;
    this.fitResizeInFlight = false;
    if (this.fitAttempts === 0) return;
    if (
      pane.innerRect.width === this.paneSize.cols &&
      pane.innerRect.height === this.paneSize.rows
    ) {
      this.fitAttempts = 0;
      this.fitResizeInFlight = false;
      return;
    }
    // Small undershoots leave harmless space. Overshoots hide content and
    // must converge even when the difference is only one cell.
    const off = (wanted: number, actual: number) =>
      actual > wanted ||
      (wanted - actual >= 2 && (wanted - actual) / wanted >= 0.02);
    if (
      !off(this.paneSize.cols, pane.innerRect.width) &&
      !off(this.paneSize.rows, pane.innerRect.height)
    ) {
      this.fitAttempts = 0;
      return;
    }
    this.requestResize(this.sizeForPane(surface, pane), surface);
  }

  // Sends at most one in-flight frame request: stale surfaces (frames from
  // before the last request applied) never trigger another resize, and
  // repeat requests for the in-flight size are dropped. Corrections resume
  // once the server streams the requested frame.
  private requestResize(
    next: { cols: number; rows: number },
    surface: EndpointSurface,
  ) {
    if (
      next.cols === this.lastRequest.cols &&
      next.rows === this.lastRequest.rows
    )
      return;
    if (
      surface.frame.width !== this.lastRequest.cols ||
      surface.frame.height !== this.lastRequest.rows
    )
      return;
    if (this.fitAttempts > 0) this.fitAttempts -= 1;
    this.fitResizeInFlight = true;
    this.lastRequest = next;
    this.client.resize(next.cols, next.rows);
  }

  input(data: Buffer) {
    this.linkFrame = null;
    if (!this.paneId || this.closed) return;
    // Typing or application input supersedes a queued history gesture.
    if (data.length > 0) {
      this.scrollTarget = null;
      this.scrollDispatched = null;
    }
    const pane = this.latestSurface()?.panes.find(
      (p) => p.paneId === this.paneId,
    );
    const events = this.classifier.feed(data).filter((event) => {
      if (event.type !== "mouse") return true;
      if (
        !pane?.mouseReporting ||
        pane.innerRect.width < 1 ||
        pane.innerRect.height < 1
      ) {
        this.pressedMouseButtons.clear();
        return false;
      }
      const inside =
        event.column < pane.innerRect.width &&
        event.row < pane.innerRect.height;
      if (event.kind === MOUSE_KIND.Down) {
        this.pressedMouseButtons.delete(event.button!);
        if (inside) this.pressedMouseButtons.add(event.button!);
        return inside;
      }
      if (event.kind === MOUSE_KIND.Drag || event.kind === MOUSE_KIND.Up) {
        if (!this.pressedMouseButtons.has(event.button!)) return false;
        // The browser canvas can exceed the crop. A gesture that began inside
        // still owns its release when it crosses into that blank canvas area.
        event.column = Math.min(event.column, pane.innerRect.width - 1);
        event.row = Math.min(event.row, pane.innerRect.height - 1);
        if (event.kind === MOUSE_KIND.Up)
          this.pressedMouseButtons.delete(event.button!);
        return true;
      }
      return inside;
    });
    this.client.sendPaneInput(this.paneId, events);
    if (this.escFlushTimer) clearTimeout(this.escFlushTimer);
    this.escFlushTimer = setTimeout(() => {
      this.escFlushTimer = null;
      if (!this.paneId || this.closed) return;
      const flushed = this.classifier.flush();
      this.client.sendPaneInput(this.paneId, flushed);
    }, ESC_FLUSH_MS);
  }

  scroll(
    direction: "up" | "down",
    lines: number,
    column?: number | null,
    row?: number | null,
    source: "wheel" | "page-key" = "wheel",
  ) {
    if (!this.paneId || !Number.isFinite(lines) || lines <= 0) return;
    lines = Math.max(1, Math.min(65535, Math.floor(lines)));
    const pane = this.latestSurface()?.panes.find(
      (p) => p.paneId === this.paneId,
    );
    // Touch scrolling uses the same bridge RPC as wheels. A page key remains
    // an explicit history action, as it was before endpoint mouse support.
    if (source === "wheel" && pane?.mouseReporting) {
      if (
        !Number.isInteger(column) ||
        !Number.isInteger(row) ||
        column! < 0 ||
        row! < 0 ||
        column! >= pane.innerRect.width ||
        row! >= pane.innerRect.height
      )
        return;
      this.linkFrame = null;
      this.client.sendPaneInput(this.paneId, [
        {
          type: "mouse",
          kind:
            direction === "up" ? MOUSE_KIND.ScrollUp : MOUSE_KIND.ScrollDown,
          column: column!,
          row: row!,
          modifiers: 0,
          lines,
        },
      ]);
      return;
    }
    this.client.assertMethod("pane.scroll");
    if (!this.lastScroll) return;
    const delta = direction === "up" ? lines : -lines;
    const offset = Math.max(
      0,
      Math.min(
        this.lastScroll.maxOffsetFromBottom,
        (this.scrollTarget ?? this.lastScroll.offsetFromBottom) + delta,
      ),
    );
    if (offset === (this.scrollTarget ?? this.lastScroll.offsetFromBottom))
      return;
    // Pending motion blocks lookups, but canceled/clamped motion may never
    // repaint. Keep the displayed token while retiring pre-gesture requests.
    this.linkLookupEpoch++;
    this.scrollTarget = offset;
    this.flushScroll();
  }

  private settleScroll() {
    const sent = this.scrollDispatched;
    if (this.scrollInFlight || !sent?.observed) return;
    this.scrollDispatched = null;
    if (this.scrollTarget === sent.offset) this.scrollTarget = null;
    this.flushScroll();
  }

  private flushScroll() {
    if (
      this.closed ||
      this.scrollInFlight ||
      this.scrollDispatched ||
      this.scrollTarget === null
    )
      return;
    this.scrollInFlight = true;
    let sent: ScrollDispatch | null = null;
    this.enqueueCommand(async () => {
      const offset = this.scrollTarget;
      if (offset === null || !this.paneId || !this.lastScroll) return;
      if (offset === this.lastScroll.offsetFromBottom) {
        // Coalescing canceled the unsent movement; no RPC or repaint is needed.
        this.scrollTarget = null;
        return;
      }
      sent = {
        offset,
        startOffset: this.lastScroll.offsetFromBottom,
        observed: false,
      };
      this.scrollDispatched = sent;
      const surfaceAtDispatch = this.latestSurface();
      const result = await this.client.callEndpoint("pane.scroll", {
        pane_id: this.paneId,
        offset_from_bottom: offset,
      });
      if (this.scrollDispatched !== sent) return;
      // Herdr 0.9.0 returns PaneInfo, including the applied (possibly clamped)
      // offset. Its revision is NOT a surface revision. Older/opaque results
      // still reconcile through surfaces; a confirmed no-op needs no repaint.
      const scroll = scrollResult(result, this.paneId);
      if (scroll && !sent.observed) {
        if (this.scrollTarget === sent.offset)
          this.scrollTarget = scroll.offset;
        else if (
          this.scrollTarget !== null &&
          this.latestSurface() === surfaceAtDispatch
        )
          this.scrollTarget = Math.min(this.scrollTarget, scroll.maxOffset);
        sent.offset = scroll.offset;
        if (scroll.offset === sent.startOffset) sent.observed = true;
      }
    })
      .then(() => {
        this.scrollInFlight = false;
        this.settleScroll();
        this.flushScroll();
      })
      .catch((e) => {
        this.scrollInFlight = false;
        if (this.scrollDispatched === sent) {
          this.scrollTarget = null;
          this.scrollDispatched = null;
        }
        this.logger.debug("endpoint pane.scroll failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        this.flushScroll();
      });
  }

  /** Read-only hit testing on the very shell that rendered the cropped pane. */
  async resolveLink(token: string, row: number, col: number) {
    const displayed = this.linkFrame;
    const epoch = this.linkLookupEpoch;
    const pane = displayed?.surface.panes.find((p) => p.paneId === this.paneId);
    const current = () =>
      !this.closed &&
      !this.connecting &&
      this.linkFrame === displayed &&
      this.linkLookupEpoch === epoch &&
      !this.fitResizeInFlight &&
      this.scrollTarget === null;
    if (
      !displayed ||
      !pane ||
      displayed.token !== token ||
      !current() ||
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      row < 0 ||
      col < 0 ||
      row >= displayed.frame.height ||
      col >= displayed.frame.width
    )
      throw new Error("Terminal link frame changed");
    // The public xterm buffer omits OSC8 IDs. Read the owned cropped frame,
    // without invoking plugins or requiring the optional plain-link resolver.
    const uri = frameHyperlinkAt(displayed.frame, row, col);
    if (uri !== undefined) return { regions: [], url: null, uri };
    if (!this.negotiation?.methods.includes("pane.link.resolve"))
      return { regions: [], url: null };
    this.client.assertMethod("pane.link.resolve");
    // Optional hover reads must not block focus/scroll or close a healthy terminal.
    const result = await this.client.callEndpoint(
      "pane.link.resolve",
      {
        pane_id: this.paneId,
        viewport_row: row,
        col,
        content_revision: pane.contentRevision,
        ...(pane.scroll
          ? { offset_from_bottom: pane.scroll.offsetFromBottom }
          : {}),
      },
      1500,
    );
    if (!current()) throw new Error("Terminal link frame changed");
    return resolvedFrameLink(result, displayed.frame, row, col);
  }

  close() {
    this.linkFrame = null;
    if (this.closed) return;
    this.closed = true;
    this.scrollTarget = null;
    this.scrollDispatched = null;
    this.pressedMouseButtons.clear();
    if (this.escFlushTimer) clearTimeout(this.escFlushTimer);
    this.clearDeferredFrame();
    this.client.close();
  }
}

function scrollResult(result: unknown, paneId: string) {
  if (
    !result ||
    typeof result !== "object" ||
    !("type" in result) ||
    result.type !== "pane_info" ||
    !("pane" in result)
  )
    return null;
  const pane = result.pane;
  if (
    !pane ||
    typeof pane !== "object" ||
    !("pane_id" in pane) ||
    pane.pane_id !== paneId ||
    !("scroll" in pane)
  )
    return null;
  const scroll = pane.scroll;
  if (
    !scroll ||
    typeof scroll !== "object" ||
    !("offset_from_bottom" in scroll) ||
    !("max_offset_from_bottom" in scroll)
  )
    return null;
  const offset = scroll.offset_from_bottom;
  const maxOffset = scroll.max_offset_from_bottom;
  if (
    typeof offset !== "number" ||
    typeof maxOffset !== "number" ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(maxOffset) ||
    offset < 0 ||
    maxOffset < offset
  )
    return null;
  return { offset, maxOffset };
}

/** Crop one pane's content rect out of the tab surface. */
export function cropFrame(
  frame: FrameData,
  rect: { x: number; y: number; width: number; height: number },
): FrameData {
  const width = Math.max(0, Math.min(rect.width, frame.width - rect.x));
  const height = Math.max(0, Math.min(rect.height, frame.height - rect.y));
  const cells = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells[y * width + x] =
        frame.cells[(rect.y + y) * frame.width + rect.x + x];
    }
  }
  let cursor = frame.cursor;
  if (cursor) {
    const x = cursor.x - rect.x;
    const y = cursor.y - rect.y;
    cursor =
      x >= 0 && x < width && y >= 0 && y < height ? { ...cursor, x, y } : null;
  }
  return { cells, width, height, cursor, hyperlinks: frame.hyperlinks };
}

/** Undefined means no OSC8; null means an invalid ID and must suppress labels. */
export function frameHyperlinkAt(
  frame: FrameData,
  row: number,
  col: number,
): string | null | undefined {
  for (let x = 0; x <= col; x++) {
    const cell = frame.cells[row * frame.width + x];
    if (!cell || cell.skip) continue;
    const width = Math.max(1, Bun.stringWidth(cell.symbol));
    if (col < x + width) {
      if (cell.hyperlink === null) return undefined;
      return frame.hyperlinks[cell.hyperlink] ?? null;
    }
    x += width - 1;
  }
  return undefined;
}

/** resolve returns regions, not a target; activate is unsafe (it runs plugins). */
export function resolvedFrameLink(
  result: unknown,
  frame: FrameData,
  row: number,
  col: number,
): {
  regions: { row: number; start_col: number; end_col: number }[];
  url: string | null;
} {
  const empty = { regions: [], url: null };
  if (
    !result ||
    typeof result !== "object" ||
    !("type" in result) ||
    result.type !== "pane_link_resolved" ||
    !("regions" in result) ||
    !Array.isArray(result.regions) ||
    result.regions.length > frame.height
  )
    return empty;
  const regions: { row: number; start_col: number; end_col: number }[] = [];
  for (const region of result.regions) {
    if (
      !region ||
      typeof region !== "object" ||
      !Number.isInteger(region.row) ||
      !Number.isInteger(region.start_col) ||
      !Number.isInteger(region.end_col) ||
      region.row < 0 ||
      region.row >= frame.height ||
      region.start_col < 0 ||
      region.end_col < region.start_col ||
      region.end_col >= frame.width ||
      (regions.length && region.row <= regions[regions.length - 1]!.row)
    )
      return empty;
    regions.push({
      row: region.row,
      start_col: region.start_col,
      end_col: region.end_col,
    });
  }
  if (
    !regions.some(
      (r) => r.row === row && r.start_col <= col && col <= r.end_col,
    )
  )
    return empty;
  const first = regions[0]!;
  const last = regions[regions.length - 1]!;
  // No upstream read-only target API exists. At either viewport edge we cannot
  // prove the URL is complete (including a clipped prefix that itself is a URL).
  if (
    (first.row === 0 && first.start_col === 0) ||
    // A wide glyph wrapping below the viewport can leave one spacer cell.
    (last.row === frame.height - 1 && last.end_col >= frame.width - 2)
  )
    return { regions, url: null };
  let url = "";
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    const previous = regions[i - 1];
    const spacer = previous && frame.cells[r.row * frame.width - 1];
    const firstCell = frame.cells[r.row * frame.width];
    const wideWrap =
      previous?.end_col === frame.width - 2 &&
      spacer?.symbol === " " &&
      !spacer.skip &&
      spacer.hyperlink === null &&
      firstCell &&
      !firstCell.skip &&
      Bun.stringWidth(firstCell.symbol) === 2;
    if (
      previous &&
      (r.row !== previous.row + 1 ||
        r.start_col !== 0 ||
        (previous.end_col !== frame.width - 1 && !wideWrap))
    )
      return { regions, url: null };
    for (let x = r.start_col; x <= r.end_col; x++) {
      const cell = frame.cells[r.row * frame.width + x];
      if (!cell || cell.hyperlink !== null) return { regions, url: null };
      if (cell.skip) continue;
      url += cell.symbol;
      x += Math.max(0, Bun.stringWidth(cell.symbol) - 1);
    }
  }
  try {
    const parsed = new URL(url);
    if (
      !/^https?:\/\//i.test(url) ||
      !parsed.hostname ||
      /[\s\u0000-\u001f\u007f]/u.test(url)
    )
      return { regions, url: null };
  } catch {
    return { regions, url: null };
  }
  return { regions, url };
}
