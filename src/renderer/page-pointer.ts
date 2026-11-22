/**
 * Where the person's pointer rests on the page, in page viewport pixels. The pane writes it and
 * a voice request reads it, so "make this one bigger" can carry what "this" is.
 */
export const pagePointer = { x: 0, y: 0, at: 0, inside: false, tabId: undefined as string | undefined };

/** A pointer still over the page that moved recently enough to be a deliberate gesture. */
export function pointedAt(now = Date.now()) {
  if (!pagePointer.inside || now - pagePointer.at > 12_000) return undefined;
  return { x: pagePointer.x, y: pagePointer.y, tabId: pagePointer.tabId };
}
