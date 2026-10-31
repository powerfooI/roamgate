/**
 * Search fields are not credentials, but password-manager extensions open
 * their autofill menu on any focused text input, covering the menu that just
 * opened. `autocomplete="off"` alone does not stop them. Bitwarden's inline
 * menu skips search fields (a `search` type, or "search" in the name) but not
 * its own opt-out attribute; the others honor theirs.
 */
export const passwordManagerIgnore = {
  type: "search",
  name: "search",
  "data-bwignore": "true",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;
