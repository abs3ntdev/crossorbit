// crengine XPointers <-> device clipping offsets, after BookOrbit's xpointer.utils.ts.
// XPointers look like /body/DocFragment[N]/body/div/p[2]/text()[1].14 where element steps are
// 1-based among same-name siblings and offsets count Unicode code points.

import type { EpubBook } from './book.js';
import { type DomNode, getDocumentElement, isElementNode, isTextNode } from './dom.js';
import { collapse, VisibleTextMap } from './visible-text.js';

interface ParsedXPointer {
  spine: number;
  steps: { name: string; index: number }[];
  textIndex: number | null;
  offset: number | null;
}

const XPOINTER_RE = /^\/body(?:\[1\])?\/DocFragment(?:\[(\d+)\])?(.*)$/;
const STEP_RE = /^([A-Za-z][\w:-]*)(?:\[(\d+)\])?$/;
const TEXT_STEP_RE = /^text\(\)(?:\[(\d+)\])?$/;

export function parseXPointer(raw: string): ParsedXPointer | null {
  const match = XPOINTER_RE.exec(raw.trim());
  if (!match) return null;
  const fragment = match[1] ? parseInt(match[1], 10) : 1;
  if (fragment < 1) return null;
  let rest = match[2] ?? '';
  let offset: number | null = null;
  const offsetMatch = /\.(\d+)$/.exec(rest);
  if (offsetMatch) {
    offset = parseInt(offsetMatch[1], 10);
    rest = rest.slice(0, -offsetMatch[0].length);
  }
  const steps: ParsedXPointer['steps'] = [];
  let textIndex: number | null = null;
  for (const segment of rest.split('/')) {
    if (!segment) continue;
    const text = TEXT_STEP_RE.exec(segment);
    if (text) {
      textIndex = text[1] ? parseInt(text[1], 10) : 1;
      continue;
    }
    if (textIndex != null) return null;
    const step = STEP_RE.exec(segment);
    if (!step) return null;
    steps.push({ name: step[1].toLowerCase(), index: step[2] ? parseInt(step[2], 10) : 1 });
  }
  if (offset != null && textIndex == null) textIndex = 1;
  return { spine: fragment - 1, steps, textIndex, offset };
}

const elementChildren = (node: DomNode, name?: string) =>
  (node.children ?? []).filter((c) => isElementNode(c) && (name == null || (c.name ?? '').toLowerCase() === name));

const textChildren = (node: DomNode) => (node.children ?? []).filter((c) => isTextNode(c));

function codePointsToUtf16(text: string, points: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen >= points) break;
    units += ch.length;
    seen++;
  }
  return units;
}

function elementPath(element: DomNode, documentElement: DomNode): string | null {
  const segments: string[] = [];
  let current: DomNode | null | undefined = element;
  while (current && current !== documentElement) {
    if (!isElementNode(current) || !current.parent) return null;
    const name = (current.name ?? '').toLowerCase();
    const siblings = elementChildren(current.parent, name);
    const index = siblings.indexOf(current) + 1;
    if (index === 0) return null;
    segments.unshift(siblings.length > 1 ? `${name}[${index}]` : name);
    current = current.parent;
  }
  return current === documentElement ? segments.join('/') : null;
}

/** XPointer for a text node point, offset in code points as crengine counts them. */
function textXPointer(spine: number, documentElement: DomNode, node: DomNode, utf16: number): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const path = elementPath(parent, documentElement);
  if (!path) return null;
  const texts = textChildren(parent);
  const index = texts.indexOf(node) + 1;
  if (index === 0) return null;
  const step = texts.length > 1 ? `text()[${index}]` : 'text()';
  return `/body/DocFragment[${spine + 1}]/${path}/${step}.${Array.from((node.data ?? '').slice(0, utf16)).length}`;
}

/** Text node and UTF-16 offset an XPointer names inside `root`, or null when it does not land in text. */
function resolveTextPoint(root: DomNode, spine: number, xpath: string): { node: DomNode; utf16: number } | null {
  const parsed = parseXPointer(xpath);
  if (!parsed || parsed.textIndex == null || parsed.spine !== spine) return null;
  let current = getDocumentElement(root);
  for (const step of parsed.steps) current = current ? (elementChildren(current, step.name)[step.index - 1] ?? null) : null;
  const node = current ? textChildren(current)[parsed.textIndex - 1] : undefined;
  if (!node) return null;
  return { node, utf16: codePointsToUtf16(node.data ?? '', parsed.offset ?? 0) };
}

export interface XPointerRange {
  pos0: string;
  pos1: string;
}

/**
 * KOReader range (pos0 start, pos1 exclusive end) for a CrossPoint clipping. The offsets are used
 * when they hold the quote, else a unique occurrence of the quote in the chapter.
 */
export function clippingToXPointers(
  book: EpubBook,
  clip: { spine: number; text: string; startOffset: number | null; endOffset: number | null },
): XPointerRange | null {
  const root = book.chapter(clip.spine);
  const documentElement = root ? getDocumentElement(root) : null;
  if (!root || !documentElement) return null;
  const map = new VisibleTextMap(root);
  let range: { start: number; end: number } | null = null;
  if (clip.startOffset != null && clip.endOffset != null && clip.endOffset <= map.length && clip.endOffset > clip.startOffset) {
    if (collapse(map.text(clip.startOffset, clip.endOffset)) === collapse(clip.text)) range = { start: clip.startOffset, end: clip.endOffset };
  }
  range ??= map.find(clip.text);
  if (!range) return null;
  const from = map.pointAt(range.start, false);
  const to = map.pointAt(range.end, true);
  if (!from || !to) return null;
  const pos0 = textXPointer(clip.spine, documentElement, from.node, from.offset);
  const pos1 = textXPointer(clip.spine, documentElement, to.node, to.offset);
  return pos0 && pos1 ? { pos0, pos1 } : null;
}

/**
 * CrossPoint chapter offsets for a KOReader range. The quote decides: when the range does not
 * hold it, a unique occurrence of the quote in the chapter is used instead.
 */
export function xpointersToOffsets(
  book: EpubBook,
  range: { pos0: string; pos1: string | null },
  text: string | null,
): { spine: number; start: number; end: number; text: string } | null {
  const spine = parseXPointer(range.pos0)?.spine;
  if (spine == null) return null;
  const root = book.chapter(spine);
  if (!root) return null;
  const map = new VisibleTextMap(root);
  const a = resolveTextPoint(root, spine, range.pos0);
  const b = range.pos1 ? resolveTextPoint(root, spine, range.pos1) : null;
  if (a && b) {
    const start = map.offsetOf(a.node, a.utf16);
    const end = map.offsetOf(b.node, b.utf16);
    if (start != null && end != null && end > start) {
      const found = map.text(start, end);
      if (!text || collapse(found) === collapse(text)) return { spine, start, end, text: text ?? found.trim() };
    }
  }
  const hit = text ? map.find(text) : null;
  return hit ? { spine, start: hit.start, end: hit.end, text: text! } : null;
}
