#!/usr/bin/env node
import { config } from '../src/shared/config.js';
import { mongoDb, ensureChunkIndexes, closeMongo } from '../src/agent/store/mongo.js';

/**
 * Prepare an Atlas cluster and prove the vector index actually serves queries.
 *
 * Atlas builds a search index asynchronously, so creating one says nothing about
 * whether it is usable yet. Querying too early returns zero results and looks
 * exactly like an empty corpus, which is the failure this script exists to make
 * impossible to mistake: it waits for READY, then runs a real $vectorSearch and
 * reports which backend answered.
 *
 *   node scripts/atlas-setup.js
 */

const mask = (uri) => String(uri).replace(/:\/\/[^@]*@/, '://<user:pass>@');

if (!config.mongo.uri) {
  console.error('MONGODB_URI is not set. Add it to .env first.');
  process.exit(1);
}

console.log(`cluster : ${mask(config.mongo.uri).slice(0, 80)}`);
console.log(`database: ${config.mongo.db}`);
console.log(`backend : ${config.mongo.vectorBackend}`);
console.log(`index   : ${config.mongo.vectorIndex} (${config.mongo.vectorDim} dims)\n`);

const db = await mongoDb();
console.log('ping    :', (await db.command({ ping: 1 })).ok === 1 ? 'ok' : 'failed');

const result = await ensureChunkIndexes();
console.log('indexes :', JSON.stringify(result));

if (config.mongo.vectorBackend !== 'atlas-vector-search') {
  console.log('\nNot an Atlas vector backend; nothing further to wait for.');
  await closeMongo();
  process.exit(0);
}

// An index reports queryable only once it has finished building.
process.stdout.write('\nwaiting for the index to become queryable');
let status = null;
for (let i = 0; i < 60; i += 1) {
  const list = await db.collection('chunks').listSearchIndexes().toArray().catch(() => []);
  const idx = list.find((x) => x.name === config.mongo.vectorIndex);
  status = idx?.status || 'MISSING';
  if (idx?.queryable) break;
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(`\nstatus  : ${status}`);

const count = await db.collection('chunks').countDocuments();
console.log(`chunks  : ${count}`);
if (!count) {
  console.log('\nNo chunks indexed yet. Upload a document, then re-run to verify retrieval.');
  await closeMongo();
  process.exit(0);
}

// A real query against the index, using an existing embedding so the vector is
// guaranteed to be the right shape for whatever embedder produced the corpus.
const sample = await db.collection('chunks').findOne({}, { projection: { embedding: 1 } });
const dims = sample?.embedding?.length;
console.log(`stored vector dims: ${dims}${dims === config.mongo.vectorDim ? '' : `  <-- does not match VECTOR_DIM=${config.mongo.vectorDim}`}`);

try {
  const hits = await db
    .collection('chunks')
    .aggregate([
      {
        $vectorSearch: {
          index: config.mongo.vectorIndex,
          path: 'embedding',
          queryVector: sample.embedding,
          numCandidates: 100,
          limit: 3,
        },
      },
      { $project: { text: 1, score: { $meta: 'vectorSearchScore' } } },
    ])
    .toArray();
  console.log(`\n$vectorSearch returned ${hits.length} result(s):`);
  for (const h of hits) console.log(`  ${h.score.toFixed(4)}  ${String(h.text).slice(0, 70)}`);
  console.log(hits.length ? '\nAtlas Vector Search is live and serving queries.' : '\nIndex is queryable but returned nothing.');
} catch (err) {
  console.log(`\n$vectorSearch failed: ${err.message}`);
  console.log('Retrieval will fall back to scanning, and /health will say so.');
}

await closeMongo();
