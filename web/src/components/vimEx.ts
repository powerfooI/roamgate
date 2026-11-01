import { Vim } from "@replit/codemirror-vim";

/** What an editor does on `:w` (and `:wq`, `:x`) and on `:q`. */
export type VimExHandlers = {
  commit: (explicit: boolean) => void;
  cancel: () => void;
};

/**
 * Vim's ex commands are global: each editor registers its handlers here,
 * keyed by its CodeMirror Vim instance.
 */
export const vimExEditors = new WeakMap<object, VimExHandlers>();
let exCommandsDefined = false;

export function defineExCommands() {
  if (exCommandsDefined) return;
  exCommandsDefined = true;
  Vim.defineEx("write", "w", (cm) => vimExEditors.get(cm)?.commit(true));
  Vim.defineEx("wq", "wq", (cm) => vimExEditors.get(cm)?.commit(true));
  Vim.defineEx("xit", "x", (cm) => vimExEditors.get(cm)?.commit(true));
  Vim.defineEx("quit", "q", (cm) => vimExEditors.get(cm)?.cancel());
}
