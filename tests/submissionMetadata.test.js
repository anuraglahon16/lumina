import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The report a grader opens must not be addressed to nobody.
 *
 * `eval/build-report.mjs` fills `student`, `trajectories.successful` and
 * `trajectories.failing` from command-line flags, and substitutes loud
 * placeholders when they are absent: `UNNAMED — pass --student "Your Name"`,
 * `MISSING-successful`, `MISSING-failing`. Those placeholders are correct
 * behaviour — a report that quietly invented a name would be worse — but they
 * were still in the published report, which means the submission was
 * anonymous and the human gate had no evidence behind it.
 *
 * The placeholders are easy to reintroduce: they come back the moment someone
 * runs the builder without its flags, which is the obvious way to run it. So
 * the invocation is pinned in package.json and this checks the artefact.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'reports', 'report.json');

const report = () => JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('the report exists to be checked at all', () => {
  assert.ok(fs.existsSync(REPORT), 'reports/report.json is missing; run `npm run report`');
});

test('the submission carries a real name', () => {
  const { student } = report();
  assert.ok(student, 'student is set');
  assert.ok(!/UNNAMED/i.test(student), `student is still the placeholder: ${student}`);
  assert.ok(!/your name/i.test(student), `student is still the placeholder: ${student}`);
  assert.ok(student.trim().length > 2, 'and it is not a stub');
});

test('both trajectories name a real run', () => {
  const { trajectories } = report();
  for (const label of ['successful', 'failing']) {
    const t = trajectories?.[label];
    assert.ok(t, `${label} trajectory is present`);
    assert.ok(!/^MISSING-/.test(t.requestId), `${label} is still MISSING: ${t.requestId}`);
    assert.match(t.requestId, /^req_[a-z0-9]+$/, `${label} names a real request id: ${t.requestId}`);
  }
});

test('both trajectories carry the steps that were actually taken', () => {
  // A request id with no steps behind it is a citation to a run nobody read.
  const { trajectories } = report();
  for (const label of ['successful', 'failing']) {
    const t = trajectories[label];
    assert.ok(Array.isArray(t.steps) && t.steps.length > 0, `${label} has tool steps`);
    // build-report renders a step as { step, tool, ok, ms, error }.
    for (const s of t.steps) assert.ok(s.tool, `${label} step names its tool`);
  }
});

test('the two trajectories are different runs, and one of each kind', () => {
  const { trajectories } = report();
  assert.notEqual(
    trajectories.successful.requestId,
    trajectories.failing.requestId,
    'naming one run twice is not reading two trajectories',
  );
  assert.equal(trajectories.successful.terminated, 'done', 'the successful one finished');
  assert.notEqual(trajectories.failing.terminated, 'done', 'and the failing one did not');
});

test('each trajectory says what the run taught, in the reader own words', () => {
  // P1 is the human gate. Steps alone are a log; the notes are the part that
  // cannot be automated, and an empty one means the gate was skipped.
  const { trajectories } = report();
  for (const label of ['successful', 'failing']) {
    const notes = trajectories[label].notes ?? '';
    assert.ok(!/^MISSING/.test(notes), `${label} notes are still the placeholder`);
    assert.ok(notes.trim().length > 200, `${label} notes are too short to be a reading: ${notes.length} chars`);
  }
});

test('the run log behind each trajectory is on disk', () => {
  // readTrajectory silently falls back to the placeholder when the file is
  // absent, so a report built on a machine without the exports would publish
  // MISSING again and this test is what notices.
  const { trajectories } = report();
  for (const label of ['successful', 'failing']) {
    const id = trajectories[label].requestId;
    const found = [path.join(ROOT, 'runs', `${id}.json`), path.join(ROOT, 'runs', 'failing', `${id}.json`)].some((p) =>
      fs.existsSync(p),
    );
    assert.ok(found, `${id} is not in runs/ or runs/failing/; regenerate with \`npm run runlogs\``);
  }
});

test('the report builder is invoked with its flags by a named script', () => {
  // The placeholders return the moment someone runs `node eval/build-report.mjs`
  // bare, which is the obvious way to run it. Pinning the invocation is what
  // stops that being a one-time fix.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const script = pkg.scripts?.report ?? '';
  assert.match(script, /build-report/, 'there is a `report` script');
  assert.match(script, /--student/, 'and it passes the student');
  assert.match(script, /--successful/, 'and the successful trajectory');
  assert.match(script, /--failing/, 'and the failing one');
});
