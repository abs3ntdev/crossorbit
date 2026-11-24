// crengine XPointer <-> EPUB CFI point conversion, ported from BookOrbit's xpointer.utils.ts.
// XPointers look like /body/DocFragment[N]/body/div/p[2]/text()[1].14 where element steps are
// 1-based among same-name siblings and offsets count Unicode code points.

import type { EpubBook } from './book.js';
import {
  type CfiNode, cfiFromPoint, chapterIndexFromSpineStep, getDocumentElement, isElementNode, isTextNode, joinCfiIndirection,
  parseCfi, resolveCfiParts, spineCfiForChapterIndex,
} from './cfi.js';

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

const elementChildren = (node: CfiNode, name?: string) =>
  (node.children ?? []).filter((c) => isElementNode(c) && (name == null || (c.name ?? '').toLowerCase() === name));

const textChildren = (node: CfiNode) => (node.children ?? []).filter((c) => isTextNode(c));

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

/** Converts a device XPointer to a CFI point. Returns null when the chapter is unknown. */
export function xpointerToCfi(book: EpubBook, xpath: string): { cfi: string; exact: boolean } | null {
  const parsed = parseXPointer(xpath);
  if (!parsed) return null;
  const root = book.chapter(parsed.spine);
  if (!root) return null;
  const spineCfi = spineCfiForChapterIndex(parsed.spine);
  const fallback = { cfi: spineCfi, exact: false };
  let current = getDocumentElement(root);
  for (const step of parsed.steps) {
    current = current ? (elementChildren(current, step.name)[step.index - 1] ?? null) : null;
  }
  if (!current || current.type === 'root') return fallback;
  let node: CfiNode = current;
  let offset: number | null = null;
  if (parsed.textIndex != null) {
    const text = textChildren(current)[parsed.textIndex - 1];
    if (text) {
      node = text;
      offset = codePointsToUtf16(text.data ?? '', parsed.offset ?? 0);
    }
  }
  try {
    return { cfi: joinCfiIndirection(spineCfi, cfiFromPoint({ node, offset: offset ?? 0 })), exact: true };
  } catch {
    return fallback;
  }
}

function elementPath(element: CfiNode, documentElement: CfiNode): string | null {
  const segments: string[] = [];
  let current: CfiNode | null | undefined = element;
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

/** Converts a CFI to a device XPointer pointing at the start of the CFI. */
export function cfiToXPointer(book: EpubBook, cfi: string): { xpath: string; spine: number } | null {
  const parsed = parseCfi(cfi);
  const spine = chapterIndexFromSpineStep(parsed?.spineStep ?? null);
  if (!parsed || spine == null) return null;
  const root = book.chapter(spine);
  const documentElement = root ? getDocumentElement(root) : null;
  if (!root || !documentElement) return null;
  const base = `/body/DocFragment[${spine + 1}]`;
  const body = elementChildren(documentElement, 'body')[0];
  if (!parsed.start.length) return body ? { xpath: `${base}/body`, spine } : null;
  const point = resolveCfiParts(root, parsed.start);
  if (!point?.node) return null;
  if (isTextNode(point.node) && point.node.parent) {
    const parent = point.node.parent;
    const path = elementPath(parent, documentElement);
    if (!path) return null;
    const texts = textChildren(parent);
    const index = texts.indexOf(point.node) + 1;
    const units = (point.node.data ?? '').slice(0, point.offset ?? 0);
    const step = texts.length > 1 ? `text()[${index}]` : 'text()';
    return { xpath: `${base}/${path}/${step}.${Array.from(units).length}`, spine };
  }
  const element = point.node === documentElement ? body : point.node;
  const path = element ? elementPath(element, documentElement) : null;
  return path ? { xpath: `${base}/${path}`, spine } : null;
}
