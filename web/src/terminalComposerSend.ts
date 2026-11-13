import type { ConnectionClient } from "./api";
import { TerminalComposerSubmitKeyError } from "./terminalComposer";
import { prepareTerminalPasteText } from "./terminalPaste";
import { terminalSubmitKey } from "./terminalSubmitKey";

/**
 * Builds the mode-aware pane input request for a composer submission. The
 * server wraps the text in bracketed-paste markers only when the PTY has
 * bracketed paste enabled, and encodes the Enter key for the active terminal
 * mode. `submit: false` inserts the draft without executing it.
 */
export function terminalComposerRequest(
  paneId: string,
  text: string,
  submit: boolean,
) {
  return {
    method: "pane.send_input" as const,
    params: {
      pane_id: paneId,
      text: prepareTerminalPasteText(text),
      keys: submit ? ["enter"] : ([] as string[]),
    },
  };
}

// Keep adjacent quoted segments and escaped characters in one shell word,
// including the Unix and PowerShell apostrophe forms from terminal-path-text.
const COMPOSER_WORD = /(?:'[^']*'|"[^"]*"|\\.|[^\s'"\\])+/g;
const UPLOADED_PATH = /[\\/]roamgate-uploads-[^\\/\s]+[\\/]/;
/**
 * How long an agent gets to take a pasted image in before what follows it.
 * Claude Code reads a pasted image path into an attachment and drops an
 * Enter that arrives meanwhile, leaving the message unsent.
 */
export const IMAGE_SETTLE_MS = 400;

/** The text cut around the uploaded image paths in it. */
export function uploadedPathPieces(
  text: string,
): Array<{ text: string; path: boolean }> {
  const pieces: Array<{ text: string; path: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(COMPOSER_WORD)) {
    const word = match[0];
    if (!/^['"]?(?:[a-z]:[\\/]|\/)/i.test(word) || !UPLOADED_PATH.test(word))
      continue;
    // Quoted names retain punctuation; unquoted sentence endings stay text.
    const path = /['"]/.test(word) ? word : word.replace(/[.,;:!?)\]]+$/, "");
    if (match.index > last)
      pieces.push({ text: text.slice(last, match.index), path: false });
    pieces.push({ text: path, path: true });
    last = match.index + path.length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), path: false });
  return pieces;
}

/**
 * Types composer text into a pane, optionally followed by the configured key.
 *
 * Claude Code only turns a paste into an image attachment when the paste is
 * the image path alone; within a sentence the path stays text. So when the
 * text holds an uploaded path and anything else, each path goes in as its
 * own paste, followed by a pause for the attachment, and the words around
 * it as theirs.
 */
export async function sendTerminalComposerText(
  client: Pick<ConnectionClient, "call">,
  paneId: string,
  text: string,
  submit: boolean,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const submitKey = terminalSubmitKey();
  const modifiedSubmit = submit && submitKey !== "enter";
  const sendModifiedSubmit = async () => {
    if (!submit || submitKey === "enter") return;
    try {
      const keys = {
        "shift-enter": "shift+enter",
        "alt-enter": "alt+enter",
        "ctrl-enter": "ctrl+enter",
        "meta-enter": "super+enter",
      } as const;
      await client.call("pane.send_keys", {
        pane_id: paneId,
        keys: [keys[submitKey]],
      });
    } catch (error) {
      throw new TerminalComposerSubmitKeyError(error);
    }
  };
  const pieces = uploadedPathPieces(text);
  const imageOnly = pieces.every((piece) => piece.path || !piece.text.trim());
  if (!pieces.some((piece) => piece.path) || (!submit && imageOnly)) {
    const request = terminalComposerRequest(
      paneId,
      text,
      submit && !modifiedSubmit,
    );
    await client.call(request.method, request.params);
    await sendModifiedSubmit();
    return;
  }
  for (const [index, piece] of pieces.entries()) {
    const last = index === pieces.length - 1;
    if (!piece.path) {
      const typed = terminalComposerRequest(
        paneId,
        piece.text,
        last && submit && !modifiedSubmit,
      );
      await client.call(typed.method, typed.params);
      continue;
    }
    const typed = terminalComposerRequest(paneId, piece.text, false);
    await client.call(typed.method, typed.params);
    await wait(IMAGE_SETTLE_MS);
    if (last && submit && !modifiedSubmit) {
      const enter = terminalComposerRequest(paneId, "", true);
      await client.call(enter.method, enter.params);
    }
  }
  await sendModifiedSubmit();
}
