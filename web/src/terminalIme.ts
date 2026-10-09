const EAST_ASIAN_PUNCTUATION_RE =
  /^(?:\p{P}|[\uff04\uff0b\uff1c-\uff1e\uff3e\uff40\uff5c\uff5e\uffe0-\uffe6])+$/u;
const RECENT_OUTPUT_LEAD_MS = 16;
const RECENT_OUTPUT_MAX_AGE_MS = 80;
const PENDING_XTERM_OUTPUT_MAX_AGE_MS = 24;
const COMMIT_CAPTURE_WINDOW_MS = 50;
const COMMIT_DUPLICATE_WINDOW_MS = 300;

type ImeInputEvent = Pick<InputEvent, "data" | "inputType" | "isComposing">;

type TimedText = {
  text: string;
  at: number;
};

type PendingInput = TimedText & {
  id: number;
};

/**
 * Returns whether an input event represents committed text whose textarea
 * mutation can safely be recovered. Composition updates are intentionally
 * excluded because replaying them would submit unfinished IME candidates.
 */
export function isTerminalImeCommittedInputType(inputType: string): boolean {
  return inputType === "insertText" || inputType === "insertFromComposition";
}

/**
 * Associates xterm data emitted during one physical key cycle with the native
 * input event that follows it. Safari still dispatches beforeinput/input after
 * xterm handles some printable keys in keypress, notably uppercase letters.
 */
export class TerminalImeKeyEventTracker {
  private active = false;
  private xtermData = "";

  begin(): void {
    this.active = true;
    this.xtermData = "";
  }

  recordXtermData(text: string): void {
    if (this.active) this.xtermData += text;
  }

  consumeInput(input: Pick<InputEvent, "data" | "inputType">): boolean {
    const alreadyHandled =
      this.active &&
      isTerminalImeCommittedInputType(input.inputType) &&
      !!input.data &&
      this.xtermData === input.data;
    this.end();
    return alreadyHandled;
  }

  end(): void {
    this.active = false;
    this.xtermData = "";
  }
}

function isEastAsianPunctuation(text: string): boolean {
  const characters = Array.from(text);
  return (
    characters.length > 0 &&
    characters.length <= 8 &&
    characters.every((character) => (character.codePointAt(0) ?? 0) > 0x7f) &&
    EAST_ASIAN_PUNCTUATION_RE.test(text)
  );
}

/**
 * Returns only punctuation committed by an IME outside an active composition.
 * Chinese text and normal ASCII keys stay entirely under xterm's control.
 */
export function terminalImeFallbackText(input: ImeInputEvent): string | null {
  if (input.isComposing || !input.data) return null;
  if (
    input.inputType &&
    input.inputType !== "insertText" &&
    input.inputType !== "insertCompositionText" &&
    input.inputType !== "insertFromComposition"
  ) {
    return null;
  }

  return isEastAsianPunctuation(input.data) ? input.data : null;
}

/**
 * Returns append-only text committed to xterm's helper textarea. Replacement
 * and deletion remain under xterm's control because replaying them here could
 * race its own keyCode 229 fallback and duplicate destructive input.
 */
export function terminalImeTextareaDelta(
  before: string,
  after: string,
): string | null {
  if (after === before || !after.startsWith(before)) return null;
  return after.slice(before.length) || null;
}

/**
 * Tracks one Apple IME textarea-mutation cycle and subtracts any prefix xterm
 * already emitted. A synchronous flush catches short-lived input/keyup
 * mutations; an unchanged cycle stays pending for one final timer fallback.
 */
export type TerminalImeTextareaFlushResult =
  | { status: "pending" }
  | { status: "unhandled" }
  | { status: "handled"; text: string | null };

export class TerminalImeTextareaFallbackTracker {
  private pending: { textareaValue: string; xtermData: string } | null = null;
  private suppressXtermData = "";

  begin(textareaValue: string): void {
    this.pending ??= { textareaValue, xtermData: "" };
  }

  recordXtermData(text: string): string | null {
    if (this.pending) this.pending.xtermData += text;
    if (!this.suppressXtermData) return text;

    if (this.suppressXtermData.startsWith(text)) {
      this.suppressXtermData = this.suppressXtermData.slice(text.length);
      return null;
    }
    if (text.startsWith(this.suppressXtermData)) {
      const unsuppressedText = text.slice(this.suppressXtermData.length);
      this.suppressXtermData = "";
      return unsuppressedText || null;
    }

    this.suppressXtermData = "";
    return text;
  }

  flush(textareaValue: string, final = false): TerminalImeTextareaFlushResult {
    const pending = this.pending;
    if (!pending) return { status: "unhandled" };
    const committedText = terminalImeTextareaDelta(
      pending.textareaValue,
      textareaValue,
    );
    if (!committedText) {
      if (final || textareaValue !== pending.textareaValue) {
        this.pending = null;
        return { status: "unhandled" };
      }
      return { status: "pending" };
    }

    this.pending = null;
    if (!committedText.startsWith(pending.xtermData)) {
      return { status: "unhandled" };
    }
    this.suppressXtermData = committedText;
    return {
      status: "handled",
      text: committedText.slice(pending.xtermData.length) || null,
    };
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  cancelPending(): void {
    this.pending = null;
  }

  complete(): void {
    this.pending = null;
    this.suppressXtermData = "";
  }

  cancel(): void {
    this.complete();
  }
}

/**
 * DOM event timestamps share performance.now()'s clock in modern browsers.
 * Fall back to observation time for older Safari timestamps that used epoch
 * milliseconds, as those cannot be compared with xterm's performance time.
 */
export function terminalImeEventTime(
  event: Pick<Event, "timeStamp">,
  observedAt: number,
): number {
  const eventAt = event.timeStamp;
  return Number.isFinite(eventAt) &&
    eventAt >= 0 &&
    eventAt <= observedAt + 1_000 &&
    observedAt - eventAt <= 60_000
    ? eventAt
    : observedAt;
}

/**
 * Routes missing IME punctuation immediately, then suppresses a matching
 * asynchronous xterm emission. Consumable records keep repeated punctuation
 * independent and preserve input order during rapid typing.
 */
export class TerminalImeFallbackTracker {
  private nextId = 1;
  private readonly pendingXtermOutput = new Map<number, PendingInput>();
  private readonly recentOutput: TimedText[] = [];

  recordInput(text: string, eventAt: number, observedAt = eventAt): boolean {
    this.prune(observedAt);
    const outputIndex = this.recentOutput.findIndex(
      (output) =>
        output.text === text &&
        output.at >= eventAt &&
        output.at <= observedAt &&
        output.at - eventAt <= RECENT_OUTPUT_LEAD_MS,
    );
    if (outputIndex >= 0) {
      this.recentOutput.splice(outputIndex, 1);
      return false;
    }

    const id = this.nextId++;
    this.pendingXtermOutput.set(id, { id, text, at: eventAt });
    return true;
  }

  recordXtermData(text: string, at: number): boolean {
    this.prune(at);
    const pending = Array.from(this.pendingXtermOutput.values()).find(
      (input) =>
        input.text === text &&
        input.at <= at &&
        at - input.at <= PENDING_XTERM_OUTPUT_MAX_AGE_MS,
    );
    if (pending) {
      this.pendingXtermOutput.delete(pending.id);
      return false;
    }
    this.recentOutput.push({ text, at });
    return true;
  }

  dispose(): void {
    this.pendingXtermOutput.clear();
    this.recentOutput.length = 0;
  }

  private prune(now: number): void {
    while (
      this.recentOutput[0] &&
      now - this.recentOutput[0].at > RECENT_OUTPUT_MAX_AGE_MS
    ) {
      this.recentOutput.shift();
    }
    for (const [id, input] of this.pendingXtermOutput) {
      if (now - input.at > PENDING_XTERM_OUTPUT_MAX_AGE_MS) {
        this.pendingXtermOutput.delete(id);
      }
    }
  }
}

/**
 * Drops the duplicate of an IME commit that arrives as a side effect of
 * switching input sources with candidates visible (e.g. pressing
 * Shift/CapsLock to leave a Chinese IME). macOS confirms such commits
 * asynchronously, so xterm emits the committed text once from its
 * compositionend finalization and then again from its own input fast path
 * when the OS re-delivers the text without a key event.
 *
 * The guard learns the committed text from xterm's first emission after each
 * compositionend (normally the composition finalization), then drops exactly
 * one identical re-emission inside a short window and records a tombstone so
 * the app-side recovery funnels do not re-send that same text when the OS
 * re-delivery arrives without a beforeinput event. A canceled composition
 * (Escape) leaves no textarea delta and never arms the guard, and each
 * compositionend re-arms the capture so legitimately repeated commits always
 * pass. New keydown, paste, and composition sessions disarm the guard before
 * xterm can emit their input. Tombstones last only through the original native
 * input's recovery cycle, including a handled flush with no missing text.
 * The guard is timer-free; windows expire lazily on the next check.
 *
 * xterm-internal double finalization is handled separately at its composition
 * helper boundary by installTerminalCompositionRepair. A finalize emission
 * delayed past this capture window simply leaves this OS-replay guard unarmed.
 */
export class TerminalImeCommitGuard {
  private captureUntil = 0;
  private committedText: string | null = null;
  private duplicateUntil = 0;
  private suppressedDuplicate: { text: string; until: number } | null = null;

  /**
   * Reopens the capture window when a composition session ends having
   * committed text. A canceled composition leaves no delta and never arms
   * the guard, so a stray emission right after Escape cannot be captured.
   */
  endComposition(at: number, committedDelta: string | null): void {
    this.beginIndependentInput();
    this.captureUntil = committedDelta ? at + COMMIT_CAPTURE_WINDOW_MS : 0;
  }

  /**
   * Filters one xterm data emission. Returns false when the emission is the
   * duplicate of the captured commit and must not reach the terminal.
   */
  filterXtermData(data: string, at: number): boolean {
    if (this.suppressedDuplicate?.text !== data) {
      this.completeRecoveryCycle();
    }
    if (this.committedText === null) {
      if (!this.captureUntil || at > this.captureUntil) return true;
      this.captureUntil = 0;
      this.committedText = data;
      this.duplicateUntil = at + COMMIT_DUPLICATE_WINDOW_MS;
      return true;
    }
    if (at > this.duplicateUntil || data !== this.committedText) {
      this.beginIndependentInput();
      return true;
    }
    this.committedText = null;
    this.duplicateUntil = 0;
    this.suppressedDuplicate = {
      text: data,
      until: at + COMMIT_DUPLICATE_WINDOW_MS,
    };
    return false;
  }

  /**
   * Consumes the tombstone of a previously suppressed duplicate when an
   * app-side recovery funnel tries to send the same text again. Without a
   * beforeinput event the textarea fallback still produces the duplicated
   * commit text, and this check is the only thing that stops it.
   */
  consumeSuppressedDuplicate(text: string, at: number): boolean {
    const suppressed = this.suppressedDuplicate;
    if (!suppressed || at > suppressed.until || suppressed.text !== text) {
      return false;
    }
    this.suppressedDuplicate = null;
    return true;
  }

  /** Retires recovery even when xterm already accounted for the whole delta. */
  completeRecoveryCycle(): void {
    this.suppressedDuplicate = null;
  }

  /** Must run before xterm handles a new keydown, paste, or composition. */
  beginIndependentInput(): void {
    this.captureUntil = 0;
    this.committedText = null;
    this.duplicateUntil = 0;
    this.completeRecoveryCycle();
  }

  dispose(): void {
    this.beginIndependentInput();
  }
}
