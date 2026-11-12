import { describe, expect, it } from 'vitest';

import { EpubBook } from '../src/epub/book.js';
import { cfiToClipping, clippingToCfi } from '../src/epub/mapping.js';
import { fixtureEpub } from './fixture.js';

const book = new EpubBook(fixtureEpub());

describe('offset <-> CFI', () => {
  it('reads the spine', () => {
    expect(book.spine).toEqual(['OPS/chapter.xhtml', 'OPS/text/two.xhtml']);
  });

  it('maps device offsets to the same CFI BookOrbit verified on device', () => {
    expect(clippingToCfi(book, { spine: 0, text: 'brave new', startOffset: 6, endOffset: 15 })).toBe('epubcfi(/6/2!/4/2,/1:6,/1:15)');
    expect(clippingToCfi(book, { spine: 0, text: 'Second paragraph', startOffset: 22, endOffset: 38 })).toBe(
      'epubcfi(/6/2!/4/4,/1:0,/1:16)',
    );
  });

  it('maps a web CFI back to device offsets', () => {
    expect(cfiToClipping(book, 'epubcfi(/6/2!/4/4,/1:7,/1:16)')).toEqual({ spine: 0, startOffset: 29, endOffset: 38, text: 'paragraph' });
  });

  it('falls back to quote search when offsets disagree', () => {
    expect(clippingToCfi(book, { spine: 0, text: 'brave  new', startOffset: 0, endOffset: 5 })).toBe('epubcfi(/6/2!/4/2,/1:6,/1:15)');
    expect(clippingToCfi(book, { spine: 0, text: 'absent', startOffset: null, endOffset: null })).toBeNull();
  });

  it('round-trips across elements and astral characters', () => {
    const cfi = clippingToCfi(book, { spine: 1, text: '\ud83d\ude00 emphasis tail', startOffset: null, endOffset: null });
    expect(cfi).toMatch(/^epubcfi\(\/6\/4!/);
    const back = cfiToClipping(book, cfi!);
    expect(back?.text).toBe('\ud83d\ude00 emphasis tail');
    expect(clippingToCfi(book, { spine: 1, text: back!.text, startOffset: back!.startOffset, endOffset: back!.endOffset })).toBe(cfi);
    expect(Array.from('Two\nCafé ').length).toBe(back!.startOffset);
  });
});
