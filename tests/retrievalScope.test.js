import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where an answer is allowed to come from.
 *
 * `mode` and `spaceId` arrive on every ask. They were validated and then
 * dropped, so a question asked against an uploaded Space was researched on the
 * open web: the answers were not wrong so much as about something else, and
 * recall over the gold set was one in thirty.
 *
 * Two rules are pinned here, and both are enforced structurally rather than
 * asked for in a prompt. A model handed a web search will use it, whatever the
 * system prompt says about preferring documents, so `docs` mode does not
 * receive web tools at all. And a Space is the scope the question was asked in,
 * so retrieval inside it cannot reach another Space's documents — that would be
 * answering from material the asker did not point at, and across users it would
 * be a leak.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-scope-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { toolDefinitionsFor } = await import('../src/agent/core/tools.js');
const { createDocument, indexChunks, searchChunks, documentStats, updateDocument } = await import('../src/agent/services/ragStore.js');

const namesFor = (opts) => toolDefinitionsFor(opts).map((t) => t.name);

/* ------------------------------------------------------------ the toolset */

test('docs mode is not offered web tools at all', () => {
  const names = namesFor({ hasDocuments: true, retrievalMode: 'docs' });
  assert.ok(names.includes('search_documents'), 'it can search the documents');
  assert.ok(!names.includes('web_search'), 'and cannot search the web');
  assert.ok(!names.includes('fetch_page'), 'nor read a page off it');
});

test('web mode is not offered the document search', () => {
  const names = namesFor({ hasDocuments: true, retrievalMode: 'web' });
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('fetch_page'));
  assert.ok(!names.includes('search_documents'));
});

test('auto mode may use either', () => {
  const names = namesFor({ hasDocuments: true, retrievalMode: 'auto' });
  for (const t of ['web_search', 'fetch_page', 'search_documents']) assert.ok(names.includes(t), `${t} is available`);
});

test('a document search is never offered when there is nothing indexed', () => {
  // A tool that can only fail is worse than an absent one: the model spends a
  // call discovering the corpus is empty and then answers anyway.
  assert.ok(!namesFor({ hasDocuments: false, retrievalMode: 'auto' }).includes('search_documents'));
  assert.ok(!namesFor({ hasDocuments: false, retrievalMode: 'docs' }).includes('search_documents'));
});

test('docs mode with an empty corpus offers no retrieval rather than the web', () => {
  // The caller asked for documents. Quietly answering from the web instead
  // would be the escalation the two modes exist to prevent.
  const names = namesFor({ hasDocuments: false, retrievalMode: 'docs' });
  assert.ok(!names.includes('web_search'));
  assert.ok(!names.includes('fetch_page'));
  assert.ok(!names.includes('search_documents'));
});

/* -------------------------------------------------------------- the Space */

const passage = (topic) =>
  `The ${topic} subsystem records every transaction in an append only ledger which operators inspect during reconciliation. `.repeat(6);

async function seedSpace({ userId, spaceId, filename, topic }) {
  const doc = await createDocument({ userId, filename, mimetype: 'text/plain', size: 100, spaceId });
  await indexChunks(doc, [{ text: passage(topic), page: 1, page_label: 'p. 1' }]);
  // The worker is what marks a document indexed in the real pipeline, and
  // `indexed` is the count that decides whether a document tool is offered.
  await updateDocument(doc.id, { status: 'indexed', stage: 'indexed', progress: 1 });
  return doc;
}

test('a Space search does not reach another Space’s documents', async () => {
  const userId = 'usr_scope_1';
  await seedSpace({ userId, spaceId: 'spc_alpha', filename: 'alpha.txt', topic: 'alpha' });
  await seedSpace({ userId, spaceId: 'spc_beta', filename: 'beta.txt', topic: 'beta' });

  const inAlpha = await searchChunks('append only ledger reconciliation', { userId, spaceId: 'spc_alpha' });
  assert.ok(inAlpha.results.length > 0, 'the Space it was asked in does answer');
  assert.ok(
    inAlpha.results.every((r) => r.filename === 'alpha.txt' || r.doc_filename === 'alpha.txt' || /alpha/.test(JSON.stringify(r))),
    'and every passage came from that Space',
  );
  assert.ok(!JSON.stringify(inAlpha.results).includes('beta'), 'nothing from the other Space leaked in');
});

test('a Space with nothing in it returns nothing, rather than everything', async () => {
  // The dangerous failure is an empty filter quietly meaning "no filter".
  const userId = 'usr_scope_2';
  await seedSpace({ userId, spaceId: 'spc_has_docs', filename: 'real.txt', topic: 'gamma' });

  const empty = await searchChunks('append only ledger reconciliation', { userId, spaceId: 'spc_empty' });
  assert.deepEqual(empty.results, [], 'an empty Space is empty');
  assert.equal(empty.corpus_size, 0);
});

test('one user’s Space never answers another user’s question', async () => {
  await seedSpace({ userId: 'usr_owner', spaceId: 'spc_shared_id', filename: 'owned.txt', topic: 'delta' });
  const intruder = await searchChunks('append only ledger reconciliation', { userId: 'usr_intruder', spaceId: 'spc_shared_id' });
  assert.deepEqual(intruder.results, [], 'a Space id is not an authorisation');
});

test('document stats describe the Space asked about, not the whole account', async () => {
  // This is what decides whether a document tool is offered at all, so counting
  // the account would offer a search over a scope that holds nothing.
  const userId = 'usr_scope_3';
  await seedSpace({ userId, spaceId: 'spc_counted', filename: 'counted.txt', topic: 'epsilon' });

  const scoped = await documentStats(userId, { spaceId: 'spc_counted' });
  const elsewhere = await documentStats(userId, { spaceId: 'spc_not_this_one' });
  const account = await documentStats(userId);

  assert.ok(scoped.indexed >= 1, 'the Space has a document');
  assert.equal(elsewhere.indexed, 0, 'a different Space has none');
  assert.ok(account.indexed >= scoped.indexed, 'the account has at least as many');
});
