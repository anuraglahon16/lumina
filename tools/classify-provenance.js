#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snippetIsGrounded, citationNumbers } from '../benchmark/lib.mjs';

/**
 * Why each citation failed the benchmark's provenance check, one at a time.
 *
 * Grounding is 0.784 against a 0.95 target: 58 of 74 verifiable citations, zero
 * dangling. Two previous attempts to fix this were generalised from too little
 * evidence — a snippet-splitter defect that was real and not dominant, and a
 * word-fusion defect that was real, fixed, and moved the number by nothing.
 * Both times the mistake was the same: read a handful of failures, form a
 * theory, and ship it.
 *
 * So this classifies every failure and implements nothing. The scorer is
 * imported from `benchmark/lib.mjs` rather than reimplemented, because a second
 * copy would drift and produce a third incompatible "grounding" number.
 *
 * Document citations are checked first because the theory there is structural
 * and needs no interpretation. `bench.mjs` builds its haystack for document
 * sources from `top5` — the first five doc sources of the answer — keyed by
 * locator, falling back to the five joined together. Our retrieval returns
 * `RAG_TOP_K: 6`. A sixth source is therefore invisible to the grader: its
 * locator is not a key and its text is not in the fallback, so a perfectly
 * honest citation to it cannot be found. That is arithmetic, and the only
 * question is how often it happens.
 *
 *   node tools/classify-provenance.js --web 12 --docs 10
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const BASE = flag('target', 'http://localhost:8787');
const OUT = 'reports';

/** Verbatim from bench.mjs, so our haystack is the grader's haystack. */
const stripHtml = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');

/** Verbatim from bench.mjs. Two chunks of one document must not share a key. */
const locatorKey = (s) => `${s.docId}:${s.locator?.page ?? ''}:${s.locator?.heading ?? ''}:${s.locator?.line ?? ''}`;

export const CATEGORY = {
  DOC_BEYOND_TOP5: 'document source beyond the grader-visible first five',
  DOC_LOCATOR: 'document locator mismatch',
  FETCH_BLOCKED: 'web page fetch blocked',
  PAGE_CHANGED: 'web page changed since the run',
  SNIPPET_ABSENT: 'snippet absent from the page',
  TOKEN_BOUNDARY: 'fused or separated token boundary',
  ENTITY: 'HTML entity difference',
  SNIPPET_SHORT: 'snippet too short to carry twelve tokens',
  DYNAMIC: 'dynamic or client-rendered page',
  DANGLING: 'citation resolves to no source',
  VERIFIED: 'provenance verified',
};

const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** How much of the snippet the grader could find, in contiguous tokens. */
function longestWindow(snippet, haystack) {
  const need = norm(snippet).split(' ').filter(Boolean);
  const hay = norm(haystack);
  for (let n = Math.min(12, need.length); n >= 2; n -= 1) {
    for (let i = 0; i + n <= need.length; i += 1) {
      if (hay.includes(need.slice(i, i + n).join(' '))) return n;
    }
  }
  return 0;
}

/* ----------------------------------------------------------------- driving */

const H = (user) => ({ 'content-type': 'application/json', 'x-user-id': user });

async function ask(user, threadId, body) {
  const res = await fetch(`${BASE}/threads/${threadId}/ask`, {
    method: 'POST',
    headers: H(user),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  });
  const text = await res.text();
  const out = { sources: [], answer: '', trace: [] };
  let event = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      let parsed;
      try {
        parsed = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (event === 'sources') out.sources = Array.isArray(parsed) ? parsed : (parsed.sources ?? []);
      else if (event === 'token') out.answer += parsed.text ?? '';
      else if (event === 'answer') out.answer = parsed.text ?? out.answer;
      else if (event === 'trace') out.trace.push(parsed);
    }
  }
  return out;
}

const newThread = async (user) =>
  (await (await fetch(`${BASE}/threads`, { method: 'POST', headers: H(user), body: '{}' })).json()).threadId;

/* ------------------------------------------------------- document citations */

/**
 * Score a document answer exactly as bench.mjs does, and record the position of
 * every cited source so "beyond the first five" is measured rather than assumed.
 */
function classifyDocAnswer(answer, record) {
  const docSources = (answer.sources ?? []).filter((s) => s.kind === 'doc');
  const top5 = docSources.slice(0, 5);
  const docText = new Map([['*', top5.map((s) => s.snippet).join('\n')]]);
  for (const s of top5) docText.set(locatorKey(s), s.snippet);

  const bySource = new Map((answer.sources ?? []).map((s) => [s.n, s]));
  const rows = [];

  for (const n of citationNumbers(answer.answer)) {
    const src = bySource.get(n);
    if (!src) {
      rows.push({ ...record, citation: n, kind: 'unknown', category: CATEGORY.DANGLING, evidence: 'no source carries this number' });
      continue;
    }
    if (src.kind !== 'doc') continue; // web sources in a doc answer are scored on the web path

    const position = docSources.findIndex((s) => s.n === n) + 1;
    const hay = docText.get(locatorKey(src)) ?? docText.get('*') ?? null;
    const grounded = hay ? snippetIsGrounded(src.snippet, hay) : false;

    rows.push({
      ...record,
      citation: n,
      kind: 'doc',
      docId: src.docId ?? null,
      locator: src.locator ?? null,
      position,
      docSourceCount: docSources.length,
      snippet: String(src.snippet ?? '').slice(0, 300),
      haystackChars: hay ? hay.length : 0,
      longestWindow: hay ? longestWindow(src.snippet, hay) : 0,
      category: grounded
        ? CATEGORY.VERIFIED
        : position > 5
          ? CATEGORY.DOC_BEYOND_TOP5
          : hay
            ? CATEGORY.DOC_LOCATOR
            : CATEGORY.DOC_LOCATOR,
      evidence:
        position > 5
          ? `cited source sits at doc position ${position} of ${docSources.length}; the grader builds its haystack from the first 5, so this source's text is in neither the keyed entry nor the '*' fallback`
          : grounded
            ? 'snippet found in the grader haystack'
            : `position ${position} is inside the top five, so the locator key must have missed: ${locatorKey(src)}`,
    });
  }
  return rows;
}

/* ------------------------------------------------------------ web citations */

const pageCache = new Map();
async function graderFetch(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  let out = { text: null, status: null };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'lumina-bench/0.1 (+course benchmark)' },
      signal: AbortSignal.timeout(12000),
    });
    out = { text: res.ok ? stripHtml(await res.text()) : null, status: res.status };
  } catch (err) {
    out = { text: null, status: err.name };
  }
  pageCache.set(url, out);
  return out;
}

async function classifyWebAnswer(answer, record) {
  const bySource = new Map((answer.sources ?? []).map((s) => [s.n, s]));
  const webSources = (answer.sources ?? []).filter((s) => s.kind !== 'doc');
  const rows = [];

  for (const n of citationNumbers(answer.answer)) {
    const src = bySource.get(n);
    if (!src) {
      rows.push({ ...record, citation: n, kind: 'unknown', category: CATEGORY.DANGLING, evidence: 'no source carries this number' });
      continue;
    }
    if (src.kind === 'doc') continue;

    const position = webSources.findIndex((s) => s.n === n) + 1;
    const { text: page, status } = await graderFetch(src.url);
    const base = {
      ...record,
      citation: n,
      kind: 'web',
      url: src.url,
      position,
      domain: (() => {
        try {
          return new URL(src.url).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })(),
      snippet: String(src.snippet ?? '').slice(0, 300),
      snippetTokens: norm(src.snippet).split(' ').filter(Boolean).length,
    };

    if (!page) {
      rows.push({ ...base, category: CATEGORY.FETCH_BLOCKED, httpStatus: status, haystackChars: 0, longestWindow: 0, evidence: `the grader's own fetch returned ${status}` });
      continue;
    }
    if (snippetIsGrounded(src.snippet, page)) {
      rows.push({ ...base, category: CATEGORY.VERIFIED, haystackChars: page.length, longestWindow: 12 });
      continue;
    }

    const window = longestWindow(src.snippet, page);
    // Why it failed, from what the page and the snippet actually are rather
    // than from a guess.
    let category = CATEGORY.SNIPPET_ABSENT;
    let evidence = `longest contiguous match ${window} of the 12 tokens required`;

    if (base.snippetTokens < 12) {
      category = CATEGORY.SNIPPET_SHORT;
      evidence = `the snippet is only ${base.snippetTokens} tokens, so the grader compares the whole of it and any difference fails`;
    } else if (window >= 6) {
      // Most of a run matches and then stops: a word boundary or an entity,
      // not a different page.
      category = /&[a-z#0-9]+;/i.test(src.snippet) ? CATEGORY.ENTITY : CATEGORY.TOKEN_BOUNDARY;
      evidence = `${window} of 12 tokens match contiguously, so the text is present and a boundary differs`;
    } else if (page.length < 2000) {
      category = CATEGORY.DYNAMIC;
      evidence = `the grader's fetch returned only ${page.length} characters, which is a shell rather than the article`;
    } else {
      category = CATEGORY.PAGE_CHANGED;
      evidence = `the page is ${page.length} characters and shares at most ${window} contiguous tokens with what we read`;
    }
    rows.push({ ...base, category, haystackChars: page.length, longestWindow: window, evidence });
  }
  return rows;
}

/* ------------------------------------------------------------------ report */

function render(report) {
  const L = [];
  const A = (line = '') => L.push(line);
  const failures = report.rows.filter((r) => r.category !== CATEGORY.VERIFIED);

  A('# Every citation provenance failure, classified\n');
  A('> Scored with `benchmark/lib.mjs`\'s own `snippetIsGrounded` and');
  A('> `citationNumbers`, against a haystack built the way `bench.mjs` builds it.');
  A('> Nothing is fixed here.\n');
  A(`- ran: ${report.ranAt}`);
  A(`- citations checked: ${report.rows.length} (${report.rows.filter((r) => r.kind === 'doc').length} document, ${report.rows.filter((r) => r.kind === 'web').length} web)`);
  A(`- verified: ${report.rows.length - failures.length} · failed: ${failures.length}\n`);

  A('## By category\n');
  A('| category | citations |');
  A('|---|---:|');
  const counts = {};
  for (const r of failures) counts[r.category] = (counts[r.category] ?? 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) A(`| ${k} | ${v} |`);
  A(`| **total failed** | **${failures.length}** |`);
  A('');

  A('## Split by surface\n');
  A('| | checked | verified | failed |');
  A('|---|---:|---:|---:|');
  for (const kind of ['doc', 'web']) {
    const all = report.rows.filter((r) => r.kind === kind);
    const bad = all.filter((r) => r.category !== CATEGORY.VERIFIED);
    A(`| ${kind} | ${all.length} | ${all.length - bad.length} | ${bad.length} |`);
  }
  A('');

  if (failures.some((r) => r.kind === 'web')) {
    A('## Web failures by domain\n');
    A('| domain | failed | categories |');
    A('|---|---:|---|');
    const byDomain = {};
    for (const r of failures.filter((x) => x.kind === 'web')) {
      byDomain[r.domain] ??= [];
      byDomain[r.domain].push(r.category);
    }
    for (const [d, cats] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
      A(`| ${d} | ${cats.length} | ${[...new Set(cats)].join(', ')} |`);
    }
    A('');
  }

  A('## Every failure\n');
  for (const r of failures) {
    A(`**[${r.citation}] ${r.kind}** · ${r.category}`);
    A(`- run: \`${r.requestId}\` (${r.depth})`);
    if (r.url) A(`- url: ${r.url}`);
    if (r.docId) A(`- doc: ${r.docId} · locator ${JSON.stringify(r.locator)} · position ${r.position} of ${r.docSourceCount}`);
    A(`- longest contiguous match: ${r.longestWindow}/12 · grader haystack ${r.haystackChars} chars`);
    A(`- snippet: ${String(r.snippet).replace(/\s+/g, ' ').slice(0, 180)}`);
    A(`- why: ${r.evidence}`);
    A('');
  }
  return `${L.join('\n')}\n`;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const webN = Number(flag('web', '12'));
  const docN = Number(flag('docs', '10'));
  const queries = JSON.parse(fs.readFileSync('benchmark/queries.json', 'utf8'));
  const rows = [];

  // Documents first: the theory there is arithmetic and needs no interpretation.
  if (docN > 0) {
    // An existing space may be named with --space, which is how this is run
    // when ingestion is not what is being measured. Otherwise one is created
    // and the corpus uploaded.
    const user = flag('space-user', `prov_doc_${Math.random().toString(36).slice(2, 8)}`);
    let spaceId = flag('space', null);

    if (!spaceId) {
      const space = await (
        await fetch(`${BASE}/spaces`, { method: 'POST', headers: H(user), body: JSON.stringify({ name: 'provenance' }) })
      ).json();
      spaceId = space.spaceId ?? space.id;

      for (const file of fs.readdirSync('eval/gold/corpus')) {
        const fd = new FormData();
        fd.append('file', new Blob([fs.readFileSync(path.join('eval/gold/corpus', file))]), file);
        const up = await fetch(`${BASE}/spaces/${spaceId}/documents`, { method: 'POST', headers: { 'x-user-id': user }, body: fd }).catch(
          (e) => ({ ok: false, status: e.message }),
        );
        if (!up.ok) process.stderr.write(`  upload ${file}: ${up.status}\n`);
      }
      for (let i = 0; i < 60; i += 1) {
        const docs = await (await fetch(`${BASE}/spaces/${spaceId}/documents`, { headers: H(user) })).json();
        const items = docs.documents ?? docs.items ?? [];
        if (items.length && items.every((d) => d.status === 'indexed')) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const gold = fs
      .readFileSync('eval/gold/rag_gold.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .slice(0, docN);

    const thread = await newThread(user);
    for (const g of gold) {
      const query = g.question ?? g.q ?? g.query;
      process.stderr.write(`  doc: ${String(query).slice(0, 52)}\n`);
      const answer = await ask(user, thread, { query, mode: 'docs', depth: 'quick', spaceId });
      const before = rows.length;
      rows.push(...classifyDocAnswer(answer, { requestId: 'doc-probe', depth: 'quick', query }));
      process.stderr.write(
        `       sources=${answer.sources.length} doc=${answer.sources.filter((s) => s.kind === 'doc').length} answerChars=${answer.answer.length} citations=${rows.length - before}\n`,
      );
    }
  }

  if (webN > 0) {
    const user = `prov_web_${Math.random().toString(36).slice(2, 8)}`;
    const thread = await newThread(user);
    const timedOut = [];
    for (const q of (queries.web ?? []).slice(0, webN)) {
      const query = typeof q === 'string' ? q : (q.query ?? q.q);
      process.stderr.write(`  web: ${String(query).slice(0, 52)}\n`);
      // A question that never comes back is a finding of its own, not a reason
      // to abandon the sample. It is recorded and the classification continues.
      let answer;
      try {
        answer = await ask(user, thread, { query, mode: 'web', depth: 'quick' });
      } catch (err) {
        timedOut.push({ query, error: err.name });
        process.stderr.write(`       ${err.name}: this question produced no answer to classify\n`);
        continue;
      }
      rows.push(...(await classifyWebAnswer(answer, { requestId: 'web-probe', depth: 'quick', query })));
    }
    if (timedOut.length) fs.writeFileSync(path.join(OUT, 'grounding-timeouts.json'), `${JSON.stringify(timedOut, null, 2)}\n`);
  }

  const report = { ranAt: new Date().toISOString(), target: BASE, rows };
  fs.writeFileSync(path.join(OUT, 'grounding-failure-distribution.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'grounding-failure-distribution.md'), render(report));

  const failed = rows.filter((r) => r.category !== CATEGORY.VERIFIED);
  console.log(`\nwrote ${OUT}/grounding-failure-distribution.json and .md`);
  console.log(`${rows.length} citations checked, ${failed.length} failed`);
  const counts = {};
  for (const r of failed) counts[r.category] = (counts[r.category] ?? 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
