import { strToU8, zipSync } from 'fflate';

export const CHAPTERS = [
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>Hello brave new world.</p><p>Second paragraph here.</p></body></html>',
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>p{}</style></head><body><h1 id="c2">Two</h1>\n<p>Caf\u00e9 \ud83d\ude00 <em>emphasis</em> tail text.</p></body></html>',
];

export function fixtureEpub(): Uint8Array {
  const opf = `<?xml version="1.0"?><package version="3.0" unique-identifier="uid" xmlns="http://www.idpf.org/2007/opf">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">x</dc:identifier><dc:title>Fixture</dc:title></metadata>
<manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OPS/content.opf': strToU8(opf),
    'OPS/chapter.xhtml': strToU8(CHAPTERS[0]),
    'OPS/text/two.xhtml': strToU8(CHAPTERS[1]),
  });
}
