/*
 * Range calculation adapted from xterm.js CompositionHelper.ts.
 * Copyright (c) 2016 The xterm.js authors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { version as xtermVersion } from "@xterm/xterm/package.json";

// Compatibility repair for @xterm/xterm 6.1.0-beta.304. The range/suffix
// calculation follows src/browser/input/CompositionHelper.ts (MIT, copyright
// 2016 The xterm.js authors). Keep the bundled-core regression tests when
// changing the pin; an incompatible helper is deliberately left untouched.
type CompositionHelper = {
  compositionstart(): void;
  _finalizeComposition(waitForPropagation: boolean): void;
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _compositionPosition: { start: number; end: number };
  _compositionSuffix: string;
  _dataAlreadySent: string;
  _textarea: { value: string; selectionStart: number | null };
  _compositionView: { classList: { remove(name: string): void } };
  _coreService: { triggerDataEvent(data: string, wasUserInput: boolean): void };
};

function compositionHelper(terminal: unknown): CompositionHelper | null {
  const helper = (
    terminal as { _core?: { _compositionHelper?: Partial<CompositionHelper> } }
  )?._core?._compositionHelper;
  if (
    !helper ||
    typeof helper.compositionstart !== "function" ||
    typeof helper._finalizeComposition !== "function" ||
    typeof helper._isComposing !== "boolean" ||
    typeof helper._isSendingComposition !== "boolean" ||
    typeof helper._compositionPosition?.start !== "number" ||
    typeof helper._compositionPosition?.end !== "number" ||
    typeof helper._compositionSuffix !== "string" ||
    typeof helper._dataAlreadySent !== "string" ||
    typeof helper._textarea?.value !== "string" ||
    typeof helper._compositionView?.classList?.remove !== "function" ||
    typeof helper._coreService?.triggerDataEvent !== "function"
  ) {
    return null;
  }
  return helper as CompositionHelper;
}

/**
 * Install after terminal.open(), before input can arrive. A non-229 key can
 * make xterm send a composition synchronously, before compositionend asks it
 * to send the same range again. Account only for output from this helper's
 * finalization, never generic onData: equal physical keys and paste are valid.
 */
export function installTerminalCompositionRepair(terminal: unknown): {
  installed: boolean;
  dispose(): void;
} {
  const helper = compositionHelper(terminal);
  if (xtermVersion !== "6.1.0-beta.304" || !helper) {
    return { installed: false, dispose() {} };
  }
  const originalStart = helper.compositionstart;
  const originalFinalize = helper._finalizeComposition;
  const originalCore = helper._coreService;
  let sentLength = 0;
  let disposed = false;
  let request = 0;
  let pending: {
    start: number;
    suffix: string;
    timer: ReturnType<typeof setTimeout>;
    request: number;
  } | null = null;

  const cancelPending = () => {
    request++;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    helper._isSendingComposition = false;
  };
  const send = (start: number, end: number) => {
    const remainingStart = start + sentLength;
    const text = helper._textarea.value.substring(
      remainingStart,
      Math.max(remainingStart, end),
    );
    // Record before onData: subscribers can synchronously trigger input.
    sentLength += text.length;
    if (text) originalCore.triggerDataEvent(text, true);
  };
  const valueEnd = (suffix: string) => {
    const value = helper._textarea.value;
    return suffix && value.endsWith(suffix)
      ? value.length - suffix.length
      : value.length;
  };
  const flush = (end?: number) => {
    const current = pending;
    if (!current) return;
    cancelPending();
    send(current.start, end ?? valueEnd(current.suffix));
  };
  const start = () => {
    // A new composition supplies a stable boundary for the previous commit.
    // Settle it before upstream resets the composition range.
    flush(helper._textarea.selectionStart ?? helper._textarea.value.length);
    cancelPending();
    sentLength = 0;
    originalStart.call(helper);
  };
  const finalize = (waitForPropagation: boolean) => {
    helper._compositionView.classList.remove("active");
    helper._isComposing = false;
    cancelPending();
    if (!waitForPropagation) {
      send(helper._compositionPosition.start, helper._compositionPosition.end);
      return;
    }
    const id = request;
    helper._isSendingComposition = true;
    const timer = setTimeout(() => {
      if (!disposed && pending?.request === id) flush();
    }, 0);
    pending = {
      start: helper._compositionPosition.start,
      suffix: helper._compositionSuffix,
      timer,
      request: id,
    };
  };
  // This facade belongs only to CompositionHelper, not the shared core.
  // Its remaining emitter is the keyCode-229 textarea fallback. Account for
  // each contiguous prefix it sends, including multiple fallback cycles;
  // upstream _dataAlreadySent only remembers the most recent cycle.
  const compositionCore = {
    triggerDataEvent(text: string, wasUserInput: boolean) {
      const offset = helper._compositionPosition.start + sentLength;
      if (text && helper._textarea.value.slice(offset).startsWith(text)) {
        sentLength += text.length;
      } else if (text === "\x7f" || text === helper._textarea.value) {
        // The native fallback also reports deletion or whole-value replacement.
        // Rebase the consumed range after that edit instead of retaining offsets
        // into the old textarea value. The fallback emission itself is unchanged.
        sentLength = Math.max(
          0,
          valueEnd(helper._compositionSuffix) -
            helper._compositionPosition.start,
        );
      }
      originalCore.triggerDataEvent(text, wasUserInput);
    },
  };
  helper._coreService = compositionCore;
  helper.compositionstart = start;
  helper._finalizeComposition = finalize;
  return {
    installed: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPending();
      if (helper._coreService === compositionCore)
        helper._coreService = originalCore;
      if (helper.compositionstart === start)
        helper.compositionstart = originalStart;
      if (helper._finalizeComposition === finalize) {
        helper._finalizeComposition = originalFinalize;
      }
    },
  };
}
