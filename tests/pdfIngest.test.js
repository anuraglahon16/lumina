import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The corpus PDFs really parse, on the Node this is running under.
 *
 * Deployed, they did not. `engines.node` said `>=20.19`, Vercel read that as
 * "newest available" and gave the function Node 24, and `pdf-parse` — which
 * vendors a pdf.js build from 2018 — threw `bad XRef entry` on every PDF. The
 * upload arrived byte-perfect (same sha256, no replacement characters, verified
 * against the running deployment) and then failed at the parser.
 *
 * Nothing caught it. The suite never parsed a real PDF, the benchmark that
 * scored Document RAG 15/15 ran against localhost on Node 21, and the deployed
 * document path had never been exercised. So the whole of document RAG was
 * broken on the deployment while every local signal said it worked.
 *
 * This test is the tripwire: it parses the same files the gold set uses, so a
 * Node or dependency bump that breaks the parser fails here rather than in
 * production. The range in `engines.node` is what keeps the deployment on a
 * version this passes under.
 */

const { parseDocument } = await import('../src/agent/services/parsers.js');
const { chunkPages } = await import('../src/agent/services/chunker.js');

const CORPUS = 'eval/gold/corpus';
const pdfs = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.pdf'));

test('the gold corpus contains PDFs to parse', () => {
  assert.ok(pdfs.length >= 2, `expected the corpus PDFs, found ${pdfs.join(', ') || 'none'}`);
});

for (const name of pdfs) {
  test(`${name} parses into pages with text`, async () => {
    const buffer = fs.readFileSync(path.join(CORPUS, name));
    const { pages, meta } = await parseDocument(buffer, { filename: name, mimetype: 'application/pdf' });

    assert.ok(pages.length > 0, 'at least one page came back');
    assert.equal(meta.kind, 'pdf');
    for (const p of pages) {
      assert.ok(p.text.trim().length > 0, `page ${p.page} has text`);
      assert.ok(Number.isInteger(p.page) && p.page >= 1, 'pages are numbered from one');
    }

    // And the text is usable downstream, not just non-empty.
    const chunks = chunkPages(pages);
    assert.ok(chunks.length > 0, 'the pages chunk into something citable');
    assert.ok(chunks.every((c) => Number.isInteger(c.line) && c.line >= 1), 'every chunk carries a line');
  });
}

test('the declared Node range excludes the version that breaks the parser', () => {
  // Node 24 is where pdf-parse's vendored pdf.js throws `bad XRef entry`. An
  // open-ended range let the platform choose it.
  const { engines } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(engines?.node, 'package.json declares a Node range');
  assert.match(engines.node, /<\s*24/, `engines.node must exclude Node 24, got ${engines.node}`);
});
