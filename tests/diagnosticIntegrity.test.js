import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { acquireLock } from '../tools/diagnostic-lock.js';

/**
 * Whether the measurements can be believed.
 *
 * This file exists because the grounding diagnostic reported on itself four
 * times running: it scored against truncated snippets, it raced a write it did
 * not wait for, four copies of it ran at once against one store, and it divided
 * supported sentences by a count of sources. Each produced a number that looked
 * like a finding. Two of them would have sent work at the wrong layer.
 *
 * A measurement that can be wrong without saying so is worse than no
 * measurement, because it is acted on.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-diagint-'));
process.env.MONGODB_URI = '';

const { EvidenceLedger } = await import('../src/agent/core/evidence.js');

const source = (n, text) => ({ n, type: 'web', url: `https://s${n}.example/p`, title: `S${n}`, text });

function ledgerWith(sources) {
  const ledger = new EvidenceLedger();
  for (const s of sources) {
    ledger.addWebSource({
      ok: true,
      url: s.url,
      final_url: s.url,
      title: s.title,
      text: s.text,
      fetched_at: new Date().toISOString(),
    });
  }
  return ledger;
}

/* ------------------------------------------------ the arithmetic of a ratio */

test('grounding is supported sentences over cited sentences, whatever the source count', () => {
  // The exact shape the diagnostic got wrong: five cited sentences, four
  // supported, two sources. Dividing by the sources gives 4/2, rounds to 1.00,
  // and turns a failing run into a perfect one.
  const facts = 'The protocol negotiates a session key during the handshake and rotates it every hour. '.repeat(8);
  const other = 'Certificate revocation lists are distributed daily to every participating resolver. '.repeat(8);
  const ledger = ledgerWith([source(1, facts), source(2, other)]);

  const answer = [
    'The protocol negotiates a session key during the handshake [1].',
    'It rotates that key every hour [1].',
    'Revocation lists are distributed daily to every participating resolver [2].',
    'Every participating resolver receives the revocation lists daily [2].',
    'The scheme guarantees forward secrecy against a quantum adversary [1].',
  ].join(' ');

  const v = ledger.validate(answer);
  assert.equal(v.cited_sentences, 5, 'five sentences carry a citation');
  assert.equal(v.cited.length, 2, 'drawn from two sources');
  assert.equal(v.supported_sentences, 4, 'four of the five are supported');
  assert.equal(v.groundedness, 0.8, 'which is four fifths, not four halves');

  // And the aggregation the diagnostic performs, stated here so the arithmetic
  // is pinned rather than assumed.
  const pooled = v.supported_sentences / v.cited_sentences;
  assert.equal(Number(pooled.toFixed(3)), 0.8);
  assert.notEqual(Math.round(v.groundedness * v.cited.length) / v.cited.length, pooled, 'the old derivation disagrees, which is the point');
});

test('pooling across runs weights by sentences, not by runs', () => {
  // A run citing one sentence perfectly and a run citing ten with eight
  // supported are not equally informative about the system.
  const runs = [
    { supported_sentences: 1, cited_sentences: 1 },
    { supported_sentences: 8, cited_sentences: 10 },
  ];
  const pooled = runs.reduce((a, r) => a + r.supported_sentences, 0) / runs.reduce((a, r) => a + r.cited_sentences, 0);
  const meanOfRatios = runs.reduce((a, r) => a + r.supported_sentences / r.cited_sentences, 0) / runs.length;
  assert.equal(Number(pooled.toFixed(4)), 0.8182);
  assert.equal(Number(meanOfRatios.toFixed(4)), 0.9);
  assert.notEqual(pooled, meanOfRatios, 'they are different numbers and must be reported separately');
});

/* ----------------------------------------- evidence beyond the first excerpt */

test('support found beyond the first 400 characters still counts', () => {
  // The snippet a source shows is its opening. Scoring against that rather than
  // against the passages the page was read into reported 0.19 for a system
  // measuring 0.87, because the answer was in the middle of the page.
  const padding = 'This introduction discusses unrelated background material at length. '.repeat(12);
  const buried = 'The vacuum daemon reclaims dead tuples once the transaction horizon advances past them. '.repeat(4);
  const ledger = ledgerWith([source(1, padding + buried)]);

  const [s] = ledger.publicSources();
  assert.ok(s.snippet.length <= 400, 'the snippet is an excerpt');
  assert.ok(!s.snippet.includes('vacuum daemon reclaims'), 'and the answer is not inside it');

  const v = ledger.validate('The vacuum daemon reclaims dead tuples once the transaction horizon advances past them [1].');
  assert.equal(v.supported_sentences, 1, 'the validator reads the passages, not the excerpt');
  assert.equal(v.groundedness, 1);
});

test('the validator records what it scored each sentence against', () => {
  // A classifier that re-derives the evidence from somewhere else is explaining
  // a different decision from the one it is explaining.
  const ledger = ledgerWith([source(1, 'Write ahead logging records changes before applying them. '.repeat(10))]);
  const v = ledger.validate('Write ahead logging records changes before applying them [1]. It does nothing else whatsoever [1].');

  assert.equal(v.sentence_results.length, 2, 'every cited sentence, supported or not');
  const [first, second] = v.sentence_results;
  assert.equal(first.supported, true);
  assert.equal(second.supported, false);
  for (const r of v.sentence_results) {
    assert.ok(typeof r.best_score === 'number');
    assert.ok(r.scored_against.length >= 1, 'with the source it was scored against');
    assert.ok(r.scored_against[0].passages.length >= 1, 'and the passages themselves');
    assert.ok(r.scored_against[0].chars > 400, 'which are the full text, not the excerpt');
  }
});

test('an unsupported sentence appears in both the weak list and the decisions', () => {
  const ledger = ledgerWith([source(1, 'Bloom filters trade memory for a false positive rate. '.repeat(10))]);
  const v = ledger.validate('Bloom filters trade memory for a false positive rate [1]. Quantum annealing solves protein folding exactly [1].');
  assert.equal(v.weak_citations.length, 1);
  assert.equal(v.sentence_results.filter((r) => !r.supported).length, 1, 'the two views agree');
});

/* ------------------------------------------------- reading across processes */

test('an in-process reader never sees a run another process wrote, which is why the diagnostic uses HTTP', () => {
  // The JSON collection reads its file once at construction and holds the
  // result, so an in-process reader sees the snapshot it began with and never
  // anything written afterwards. Polling harder cannot help. The diagnostic
  // reads over HTTP for this reason; this test is what establishes that the
  // import-and-poll approach it used before genuinely could not work.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-xproc-'));
  const writer = `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.MONGODB_URI = '';
    const { collection } = await import('${path.resolve('src/agent/store/jsonStore.js')}');
    const runs = collection('runs');
    await runs.put({ id: 'run_from_other_process', user_id: 'u_x', created_at: new Date().toISOString() });
    await runs.flush();
  `;
  const reader = `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.MONGODB_URI = '';
    const { collection } = await import('${path.resolve('src/agent/store/jsonStore.js')}');
    const runs = collection('runs');            // loaded before the write
    const before = (await runs.list({}, { limit: 10 })).items.length;
    ${JSON.stringify('')};
    await new Promise((r) => setTimeout(r, 400));
    const after = (await runs.list({}, { limit: 10 })).items.length;
    console.log(JSON.stringify({ before, after }));
  `;

  // Reader first, so its snapshot predates the write.
  const readerProc = execFileSync('node', ['--input-type=module', '-e', reader.replace('${JSON.stringify(\'\')};', '')], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, MONGODB_URI: '' },
  });
  execFileSync('node', ['--input-type=module', '-e', writer], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, MONGODB_URI: '' } });

  const { before, after } = JSON.parse(readerProc.trim().split('\n').pop());
  assert.equal(before, 0, 'the reader started with an empty snapshot');
  assert.equal(after, 0, 'and never saw the write, however long it waited');
});

/* --------------------------------------------------------------- the lock */

test('a second diagnostic cannot take a lock the first still holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-lock-'));
  const first = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /holds the lock/);
  assert.equal(first.release(), true);
  // And once released, the next one may have it.
  const second = acquireLock(dir);
  assert.ok(second.token);
  second.release();
});

test('a lock left by a process that is gone is recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-lock2-'));
  fs.writeFileSync(path.join(dir, '.diagnostic.lock'), JSON.stringify({ pid: 999999, token: 'stale', started: 'earlier' }));
  const lock = acquireLock(dir);
  assert.ok(lock.token, 'a crashed run does not require someone to find and delete a file');
  lock.release();
});

test('only one of several processes recovers the same stale lock', async () => {
  // The version this replaces checked for staleness and then overwrote, which
  // is two steps with a gap: everyone finds the same dead lock, everyone
  // decides to take it, everyone writes, and everyone believes they hold it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-lock3-'));
  fs.writeFileSync(path.join(dir, '.diagnostic.lock'), JSON.stringify({ pid: 999999, token: 'stale', started: 'earlier' }));

  const helper = path.resolve('tools/diagnostic-lock.js');
  const contenders = await Promise.all(
    Array.from({ length: 5 }, () =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(helper)};
             try { const l = acquireLock(${JSON.stringify(dir)}); console.log('WON'); await new Promise(r => setTimeout(r, 150)); l.release(); }
             catch { console.log('LOST'); }`],
          { encoding: 'utf8' },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => resolve(out.trim()));
      }),
    ),
  );

  assert.equal(contenders.filter((r) => r === 'WON').length, 1, `exactly one winner, got: ${contenders.join(', ')}`);
});

test('a late finisher does not delete a lock someone else now holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-lock4-'));
  const first = acquireLock(dir);
  first.release();
  const second = acquireLock(dir);

  // The first process, finishing late, tries to release again.
  assert.equal(first.release(), false, 'it reports that the lock was not its to release');
  assert.ok(fs.existsSync(path.join(dir, '.diagnostic.lock')), 'and the current holder still has it');
  second.release();
});

/* ------------------------------------- the evidence behind a support score */

test('supporting text in a later passage is preserved in the record', () => {
  // The score is computed from the source's whole term set, so keeping only
  // the first few passages can omit the very text that produced the number.
  const filler = Array.from({ length: 5 }, (_, i) => `Section ${i} discusses unrelated preliminaries in some detail. `.repeat(12));
  const buried = 'The reclaim daemon compacts partially filled extents once utilisation drops below the configured floor. '.repeat(6);
  const ledger = ledgerWith([source(1, `${filler.join('\n\n')}\n\n${buried}`)]);

  // publicSources deliberately carries a snippet rather than the full text;
  // the passages are what scoring uses and what the record must keep.
  const passages = ledger.sources[0].passages;
  assert.ok(passages.length >= 3, `the source split into several passages (${passages.length})`);
  assert.ok(
    !passages.slice(0, 2).join(' ').includes('reclaim daemon compacts'),
    'and the supporting text is not in the first couple of them',
  );

  const v = ledger.validate(
    'The reclaim daemon compacts partially filled extents once utilisation drops below the configured floor [1].',
  );
  assert.equal(v.supported_sentences, 1, 'the sentence is supported by text late in the page');

  const kept = v.sentence_results[0].scored_against[0].passages.join(' ');
  assert.ok(kept.includes('reclaim daemon compacts partially filled extents'), 'and the supporting text is in the record');
});

test('support beyond 1,200 characters of a passage is preserved', () => {
  // Truncating a passage for storage drops the sentence that produced the
  // score, leaving a record that cannot explain its own number.
  const lead = 'Preamble about configuration defaults and historical context. '.repeat(30);
  const answerText = 'Checksums are verified on every read and a mismatch triggers an immediate repair from the mirror. ';
  const ledger = ledgerWith([source(1, lead + answerText.repeat(4))]);

  const v = ledger.validate('Checksums are verified on every read and a mismatch triggers an immediate repair from the mirror [1].');
  assert.equal(v.supported_sentences, 1);

  const kept = v.sentence_results[0].scored_against[0].passages.join(' ');
  assert.ok(kept.length > 1200, `the record keeps more than a truncated window (${kept.length} chars)`);
  assert.ok(kept.includes('triggers an immediate repair from the mirror'), 'including the supporting sentence');
});
