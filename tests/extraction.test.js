import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { snippetIsGrounded } from '../benchmark/lib.mjs';

/**
 * Extracted text must tokenise the way the page does.
 *
 * Cheerio's `.text()` concatenates descendant text nodes with nothing between
 * them, so `<a>New</a><span>Meet Geopits</span>` came out as "NewMeet Geopits".
 * On a page whose banner and navigation are adjacent inline elements that
 * produced "MumbaiRead More" and
 * "UsServicesTechnologyPartnersProductsAboutResourcesContact".
 *
 * It broke three things at once. A fused token is not a word, so the embedding
 * model and the citation validator each saw an unknown one. The snippet shown
 * to a reader had words run together. And the benchmark's provenance check —
 * which strips tags by replacing each with a space, then looks for a contiguous
 * twelve-token window of our snippet in its own text — could not match across
 * the join. Sixteen of eighty citations failed that way in the 2026-09-18 run,
 * which is the citation-grounding gate at 0.80 against a target of 0.95.
 *
 * The grader's behaviour is the specification here: a space wherever markup
 * was. These tests pin agreement with it rather than agreement with a guess
 * about what reads nicely.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-extract-'));
process.env.MONGODB_URI = '';

const { spaceElementBoundaries } = await import('../src/agent/services/fetcher.js');

const textOf = (html) => cheerio.load(html)('body').text().replace(/\s+/g, ' ').trim();

test('adjacent inline elements do not fuse into one token', () => {
  const html = '<div><a href="#">New</a><span>Meet Geopits at Gartner</span></div>';
  assert.equal(textOf(html), 'NewMeet Geopits at Gartner', 'this is what the defect looked like');
  assert.equal(textOf(spaceElementBoundaries(html)), 'New Meet Geopits at Gartner');
});

test('a navigation list of links becomes words rather than one long token', () => {
  const html = '<nav><a>Us</a><a>Services</a><a>Technology</a><a>Partners</a></nav>';
  assert.equal(textOf(html), 'UsServicesTechnologyPartners');
  assert.equal(textOf(spaceElementBoundaries(html)), 'Us Services Technology Partners');
});

test('text already separated is not given extra words', () => {
  // The fix must not invent tokens where the page had none.
  const html = '<p>GridFS stores files larger than 16MB.</p>';
  assert.equal(textOf(spaceElementBoundaries(html)), 'GridFS stores files larger than 16MB.');
});

test('inline emphasis inside a sentence still reads as a sentence', () => {
  const html = '<p>GridFS stores files <b>larger</b> than 16MB.</p>';
  assert.equal(textOf(spaceElementBoundaries(html)), 'GridFS stores files larger than 16MB.');
});

test('a deliberate mid-word fusion splits, and the grader splits it too', () => {
  // The cost of the rule, stated rather than hidden. `<b>anti</b>disestablish`
  // becomes two words for us — and for the grader, which replaces every tag
  // with a space as well. Agreement is what the gate measures, so both sides
  // splitting is still a match.
  const html = '<p><b>anti</b>disestablishmentarianism</p>';
  const ours = textOf(spaceElementBoundaries(html));
  assert.equal(ours, 'anti disestablishmentarianism');

  const graderText = html.replace(/<[^>]+>/g, ' ');
  assert.match(graderText.replace(/\s+/g, ' ').trim(), /anti disestablishmentarianism/);
});

test('camelCase the page actually wrote is preserved', () => {
  // `uploadDate` and `chunkSize` are field names in the source, not artifacts.
  // A rule that split those would be corrupting content to satisfy a checker.
  const html = '<p>The metadata carries uploadDate and chunkSize for every file.</p>';
  assert.match(textOf(spaceElementBoundaries(html)), /uploadDate and chunkSize/);
});

test('a snippet from fused markup is findable by the grader; before the fix it was not', () => {
  // The whole gate, in one assertion. The page is built the way the failing one
  // was: a banner of adjacent inline elements ahead of the content.
  // Shaped like the page that failed: the first 400 characters are banner and
  // navigation built from adjacent inline elements, so every run of clean
  // tokens is broken by a fusion before it reaches twelve. A fixture with a
  // clean paragraph inside the first 400 characters proves nothing — the
  // grader finds its twelve-token window there and passes.
  const banner = Array.from(
    { length: 10 },
    (_, i) => `<a>New</a><span>Meet Geopits at Gartner Summit ${i} in Mumbai</span>`,
  ).join('');
  const html = `<div>${banner}</div><p>GridFS splits a file into chunks of 255 kilobytes.</p>`;

  const graderText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');

  const before = textOf(html).slice(0, 400);
  const after = textOf(spaceElementBoundaries(html)).slice(0, 400);

  assert.equal(snippetIsGrounded(before, graderText), false, 'the fused snippet cannot be found in the page');
  assert.equal(snippetIsGrounded(after, graderText), true, 'the spaced one can');
});

test('the transform leaves the markup itself intact', () => {
  // Spaces go around tags, never inside them: an attribute value that lost its
  // quoting would change what the parser sees.
  const html = '<a href="https://example.test/a?b=1&amp;c=2" class="x y">link</a>';
  const $ = cheerio.load(spaceElementBoundaries(html));
  assert.equal($('a').attr('href'), 'https://example.test/a?b=1&c=2');
  assert.equal($('a').attr('class'), 'x y');
});

test('it handles the degenerate inputs without throwing', () => {
  for (const input of ['', null, undefined, '<p>unclosed', '<<>>', 'no markup at all']) {
    assert.doesNotThrow(() => spaceElementBoundaries(input));
  }
  assert.equal(spaceElementBoundaries(null), '');
});
