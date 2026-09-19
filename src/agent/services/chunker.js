import { config } from '../../shared/config.js';

/**
 * Chunk page-structured text. Chunks never span pages, so every chunk keeps an
 * exact page number and RAG citations can say "report.pdf, p. 7" truthfully.
 */
export function chunkPages(pages, { chunkChars = config.rag.chunkChars, overlap = config.rag.chunkOverlap } = {}) {
  const chunks = [];
  for (const page of pages) {
    const text = (page.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    // Line offsets for the page, computed once: index i holds the character
    // offset at which line i+1 begins.
    const lineStarts = [0];
    for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);

    for (const piece of splitWithOverlap(text, chunkChars, overlap)) {
      if (piece.text.trim().length < 60) continue;
      chunks.push({
        index: chunks.length,
        page: page.page,
        page_label: page.label || `p. ${page.page}`,
        char_start: piece.start,
        char_end: piece.end,
        /**
         * The line this chunk actually starts on, 1-based within the page.
         *
         * Two things need it. A reader following "p. 3, line 12" can find the
         * passage, which is the whole point of a locator. And the benchmark
         * keys its per-source haystack on `docId:page:heading:line` — its own
         * comment warns that "two chunks of one document must not share a key"
         * — so a locator carrying only a page made every chunk of a page
         * collide, `Map.set` kept the last, and a citation to an earlier chunk
         * was scored against a different passage and failed.
         *
         * Derived from `char_start` rather than invented. A chunk ordinal
         * presented as a line would satisfy the key and lie to the reader.
         */
        // The line the *citable* text starts on, not the raw slice. Overlap
        // makes a piece begin partway through the previous line, and a locator
        // pointing at a line the quoted passage does not start on sends a
        // reader to the wrong place.
        line: lineAt(lineStarts, piece.start + (piece.text.length - piece.text.trimStart().length)),
        text: piece.text.trim(),
      });
    }
  }
  return chunks;
}

/** Prefer paragraph, then sentence, then hard boundaries when splitting. */
function splitWithOverlap(text, size, overlap) {
  if (text.length <= size) return [{ text, start: 0, end: text.length }];
  const out = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + size);
    if (end < text.length) {
      const window = text.slice(cursor, end);
      const paragraphBreak = window.lastIndexOf('\n\n');
      const sentenceBreak = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      if (paragraphBreak > size * 0.5) end = cursor + paragraphBreak;
      else if (sentenceBreak > size * 0.5) end = cursor + sentenceBreak + 1;
    }
    out.push({ text: text.slice(cursor, end), start: cursor, end });
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out;
}

/**
 * Split fetched web-page text into citable passages. Web pages have no pages,
 * so the "locator" is a passage index, still precise enough to quote.
 */
export function chunkPassages(text, { maxChars = 1400 } = {}) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const passages = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim().length > 80) passages.push(buffer.trim());
    buffer = '';
  };
  for (const p of paragraphs) {
    if ((buffer + p).length > maxChars) flush();
    buffer = buffer ? `${buffer}\n\n${p}` : p;
  }
  flush();
  return passages;
}

/** Which 1-based line an offset falls on, by binary search over line starts. */
function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
