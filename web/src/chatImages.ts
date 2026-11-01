/**
 * An image Roamgate uploaded for a message: the composer puts its path in the
 * text (see terminal-upload), in the system temporary directory.
 */
// A whole path: it starts a word (or follows an opening quote or bracket)
// and ends one (or comes before punctuation).
const UPLOADED_IMAGE =
  /(?<![^\s"'`(<[])(?:[a-z]:)?[\\/](?:[^\s\\/]+[\\/])*roamgate-uploads-[^\s\\/]+[\\/](?:[^\s\\/]+[\\/])*[^\s\\/]+\.(?:png|jpe?g|gif|webp|avif|bmp)(?=[.,;:!?]*(?:[\s)\]>"'`]|$))/gi;

export type MessagePiece =
  | { text: string }
  /** An uploaded image's path, or with `url` an image the message carried. */
  | { image: string; url?: string };

/** A message's text, with the uploaded image paths in it apart. */
export function messageImagePieces(text: string): MessagePiece[] {
  const pieces: MessagePiece[] = [];
  let from = 0;
  for (const match of text.matchAll(UPLOADED_IMAGE)) {
    const before = text.slice(from, match.index).trim();
    if (before) pieces.push({ text: before });
    pieces.push({ image: match[0] });
    from = match.index + match[0].length;
  }
  const rest = text.slice(from).trim();
  if (rest) pieces.push({ text: rest });
  return pieces;
}

// How Claude Code shows, in a message's text, an image pasted into it.
const ATTACHED_IMAGE = /\[Image #\d+\]/g;

/**
 * A message's text, with Claude Code's [Image #N] marks standing for the
 * images it carried (`urls`, in their order); images without a mark follow
 * the words.
 */
export function attachedImagePieces(
  text: string,
  urls: readonly string[],
): MessagePiece[] {
  const pieces: MessagePiece[] = [];
  let from = 0;
  let next = 0;
  for (const match of text.matchAll(ATTACHED_IMAGE)) {
    if (next >= urls.length) break;
    const before = text.slice(from, match.index).trim();
    if (before) pieces.push(...messageImagePieces(before));
    pieces.push({ image: match[0].slice(1, -1), url: urls[next++]! });
    from = match.index + match[0].length;
  }
  const rest = text.slice(from).trim();
  if (rest) pieces.push(...messageImagePieces(rest));
  for (; next < urls.length; next++)
    pieces.push({ image: `Image #${next + 1}`, url: urls[next]! });
  return pieces;
}
