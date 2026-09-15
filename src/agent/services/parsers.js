import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';

const require = createRequire(import.meta.url);

export const SUPPORTED_TYPES = {
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/html': 'html',
  'application/json': 'text',
  'text/csv': 'text',
};

export function detectKind(filename, mimetype) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || mimetype === 'application/pdf') return 'pdf';
  if (['html', 'htm'].includes(ext) || /html/.test(mimetype || '')) return 'html';
  if (['txt', 'md', 'markdown', 'csv', 'json', 'log', 'rst'].includes(ext)) return 'text';
  if (/^text\//.test(mimetype || '')) return 'text';
  return null;
}

/**
 * Parse an uploaded file into page-structured text.
 * Returns { pages: [{page, text, label}], meta }.
 */
export async function parseDocument(buffer, { filename, mimetype }) {
  const kind = detectKind(filename, mimetype);
  if (!kind) throw new Error(`unsupported file type: ${mimetype || filename}`);

  if (kind === 'pdf') return parsePdf(buffer);

  if (kind === 'html') {
    const $ = cheerio.load(buffer.toString('utf8'));
    $('script, style, noscript, nav, footer, header').remove();
    const title = $('title').first().text().trim() || filename;
    return paginateFlatText($('body').text(), { title, kind: 'html' });
  }

  return paginateFlatText(buffer.toString('utf8'), { title: filename, kind: 'text' });
}

async function parsePdf(buffer) {
  // Import the library entry point directly: pdf-parse's index.js runs a
  // self-test when `module.parent` is undefined, which is always true under ESM.
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const pages = [];
  await pdfParse(buffer, {
    // Called once per page; this is what gives us real page numbers.
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 4) text += '\n';
        else if (text && !text.endsWith(' ')) text += ' ';
        text += item.str;
        lastY = y;
      }
      pages.push({ page: pages.length + 1, text: text.replace(/[ \t]+/g, ' ').trim(), label: `p. ${pages.length + 1}` });
      return text;
    },
  });
  const meta = { title: null, kind: 'pdf', page_count: pages.length };
  return { pages: pages.filter((p) => p.text.length > 0), meta };
}

/** Flat text gets synthetic ~3k-character "pages" so locators stay meaningful. */
function paginateFlatText(raw, meta) {
  const text = raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const PAGE_CHARS = 3000;
  const pages = [];
  for (let i = 0; i < text.length; i += PAGE_CHARS) {
    const n = pages.length + 1;
    pages.push({ page: n, text: text.slice(i, i + PAGE_CHARS), label: `section ${n}` });
  }
  if (!pages.length) pages.push({ page: 1, text, label: 'section 1' });
  return { pages, meta: { ...meta, page_count: pages.length } };
}
