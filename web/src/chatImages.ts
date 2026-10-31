/**
 * An image Roamgate uploaded for a message: the composer puts its path in the
 * text (see terminal-upload), in the system temporary directory.
 */
// A whole path: it starts a word (or follows an opening quote or bracket)
// and ends one (or comes before punctuation).
const UPLOADED_IMAGE =
  /(?<![^\s"'`(<[])(?:[a-z]:)?[\\/](?:[^\s\\/]+[\\/])*roamgate-uploads-[^\s\\/]+[\\/](?:[^\s\\/]+[\\/])*[^\s\\/]+\.(?:png|jpe?g|gif|webp|avif|bmp)(?=[.,;:!?]*(?:[\s)\]>"'`]|$))/gi;

export type MessagePiece = { text: string } | { image: string };

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
