import {
  cfiFromRangePoints,
  chapterIndexFromSpineStep,
  isTextNode,
  joinCfiIndirection,
  parseCfi,
  resolveCfiParts,
  spineCfiForChapterIndex,
} from './cfi.js';
import type { EpubBook } from './book.js';
import { collapse, VisibleTextMap } from './visible-text.js';

export interface ClippingAnchor {
  spine: number;
  text: string;
  startOffset: number | null;
  endOffset: number | null;
}

export function clippingToCfi(book: EpubBook, anchor: ClippingAnchor): string | null {
  const root = book.chapter(anchor.spine);
  if (!root) return null;
  const map = new VisibleTextMap(root);
  let range: { start: number; end: number } | null = null;
  if (anchor.startOffset != null && anchor.endOffset != null && anchor.endOffset <= map.length) {
    const candidate = { start: anchor.startOffset, end: anchor.endOffset };
    if (collapse(map.text(candidate.start, candidate.end)) === collapse(anchor.text)) range = candidate;
  }
  range ??= map.find(anchor.text);
  if (!range) return null;
  const start = map.pointAt(range.start, false);
  const end = map.pointAt(range.end, true);
  if (!start || !end) return null;
  try {
    return joinCfiIndirection(spineCfiForChapterIndex(anchor.spine), cfiFromRangePoints(start, end));
  } catch {
    return null;
  }
}

export function cfiToClipping(book: EpubBook, cfi: string): { spine: number; startOffset: number; endOffset: number; text: string } | null {
  const parsed = parseCfi(cfi);
  const spine = chapterIndexFromSpineStep(parsed?.spineStep ?? null);
  if (!parsed || spine == null) return null;
  const root = book.chapter(spine);
  if (!root) return null;
  const start = resolveCfiParts(root, parsed.start);
  const end = resolveCfiParts(root, parsed.end);
  if (!start?.node || !end?.node || !isTextNode(start.node) || !isTextNode(end.node)) return null;
  const map = new VisibleTextMap(root);
  const startOffset = map.offsetOf(start.node, start.offset ?? 0);
  const endOffset = map.offsetOf(end.node, end.offset ?? 0);
  if (startOffset == null || endOffset == null || endOffset <= startOffset) return null;
  const text = map.text(startOffset, endOffset).trim();
  if (!text) return null;
  return { spine, startOffset, endOffset, text };
}
