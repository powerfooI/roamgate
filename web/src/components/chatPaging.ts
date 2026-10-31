/**
 * Page Up / Page Down in an agent chat's message box: the conversation
 * scrolls by a page, as it would with the box not focused.
 */
export function scrollChatPage(from: Element, direction: 1 | -1): boolean {
  const list = from
    .closest(".agent-history-messages")
    ?.querySelector<HTMLElement>(".agent-history-chat");
  if (!list) return false;
  list.scrollBy({ top: direction * list.clientHeight * 0.9 });
  return true;
}
