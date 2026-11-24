import { describe, expect, it } from 'vitest';

import { EpubBook } from '../src/epub/book.js';
import { clippingToXPointers, parseXPointer, xpointersToOffsets } from '../src/epub/xpointer.js';
import { fixtureEpub } from './fixture.js';

const book = new EpubBook(fixtureEpub());
const P = (n: number, offset: number) => `/body/DocFragment[1]/body/p[${n}]/text().${offset}`;

describe('device offsets <-> KOReader xpointers', () => {
  it('reads the spine and parses xpointers', () => {
    expect(book.spine).toEqual(['OPS/chapter.xhtml', 'OPS/text/two.xhtml']);
    expect(parseXPointer('/body/DocFragment[2]/body/p/text()[1].6')).toMatchObject({ spine: 1, textIndex: 1, offset: 6 });
    expect(parseXPointer('epubcfi(/6/2)')).toBeNull();
  });

  it('maps device offsets to text ranges', () => {
    expect(clippingToXPointers(book, { spine: 0, text: 'brave new', startOffset: 6, endOffset: 15 })).toEqual({ pos0: P(1, 6), pos1: P(1, 15) });
    expect(clippingToXPointers(book, { spine: 0, text: 'Second paragraph', startOffset: 22, endOffset: 38 })).toEqual({ pos0: P(2, 0), pos1: P(2, 16) });
  });

  it('maps a BookOrbit range back to device offsets', () => {
    expect(xpointersToOffsets(book, { pos0: P(2, 7), pos1: P(2, 16) }, 'paragraph')).toEqual({ spine: 0, start: 29, end: 38, text: 'paragraph' });
    expect(xpointersToOffsets(book, { pos0: '/body/DocFragment[1]/body/div[9]/text().0', pos1: null }, 'x')).toBeNull();
  });

  it('falls back to quote search when offsets disagree', () => {
    expect(clippingToXPointers(book, { spine: 0, text: 'brave  new', startOffset: 0, endOffset: 5 })).toEqual({ pos0: P(1, 6), pos1: P(1, 15) });
    expect(clippingToXPointers(book, { spine: 0, text: 'absent', startOffset: null, endOffset: null })).toBeNull();
    expect(clippingToXPointers(book, { spine: 0, text: 'ra', startOffset: null, endOffset: null })).toBeNull();
  });

  it('round-trips across elements and astral characters in code points', () => {
    const range = clippingToXPointers(book, { spine: 1, text: '\ud83d\ude00 emphasis tail', startOffset: null, endOffset: null })!;
    expect(range.pos0).toBe('/body/DocFragment[2]/body/p/text()[1].5');
    expect(range.pos1).toBe('/body/DocFragment[2]/body/p/text()[2].5');
    const back = xpointersToOffsets(book, range, null);
    expect(back?.text).toBe('\ud83d\ude00 emphasis tail');
    expect(Array.from('Two\nCafé ').length).toBe(back!.start);
    expect(clippingToXPointers(book, { spine: 1, text: back!.text, startOffset: back!.start, endOffset: back!.end })).toEqual(range);
  });
});
