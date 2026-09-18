#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaimAboutEvidence } from '../src/agent/core/evidence.js';

/**
 * What shape is the sentence that should have been cited and was not?
 *
 * A guess about this was already wrong once. Reading fourteen of the fifty-one
 * remaining misses, three of which happened to be a run of specification
 * bullets, I reported that the residue was concentrated in lists and formulas.
 * It is not: three of the fifty-one are list items. The overwhelming majority
 * are ordinary continuation sentences in prose — exactly what the contract
 * already forbids, still happening.
 *
 * That matters for what to do next, which is why this is a tool and not a
 * script run once. Fixing lists would address six percent of the gap. Knowing
 * that before writing prompt text is the difference between a targeted change
 * and a plausible one.
 *
 * Classification here is structural: it reads the shape of the sentence, not
 * its meaning. Shape is what a regular expression can actually settle — whether
 * a line begins with a bullet, whether it carries an equation, whether it ends
 * in a colon introducing something. Whether a sentence asserts anything worth
 * citing is a judgement and is left as `unclassified` for a person rather than
 * decided by a pattern that cannot see meaning.
 *
 *   node tools/classify-misses.js --ab reports/prompt-ab.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

/** Structural categories, in precedence order: the first match wins. */
export const SHAPES = [
  {
    key: 'list_item',
    test: (t) => /^\s*(?:[-*+•]|\d+[.)])\s+\S/.test(t),
    note: 'a bullet or numbered item, which the contract says must carry its own marker',
  },
  {
    key: 'formula_or_spec',
    test: (t) => /(?:^|\s)(?:[A-Za-z_]\w*\s*=\s*\S|\d+\s*[*x×]\s*[A-Za-z]|[<>]=?\s*\d|≤|≥)/.test(t),
    note: 'an equation, variable definition or numeric specification',
  },
  {
    key: 'list_introduction',
    test: (t) => /:\s*$/.test(t.trim()),
    note: 'a line introducing a list; organisational rather than a claim of its own',
  },
  {
    key: 'quotation_fragment',
    // A fragment that opens mid-quotation: the splitter broke inside a quoted
    // title. Not a sentence, so not a miss.
    test: (t) => /^[^"“]*["”]\s/.test(t) && !/^["“]/.test(t.trim()),
    note: 'not a sentence: the splitter broke inside a quoted title',
  },
  {
    key: 'evidence_gap_disclosure',
    test: (t) => isClaimAboutEvidence(t) || /\b(?:the evidence|the article|the document|the source)\b[^.]*\b(?:does not|do not|but it does not|mentions? that)\b/i.test(t) || /\bI would need\b/i.test(t),
    note: 'describes what the evidence does or does not cover; the contract requires these to stay uncited',
  },
  {
    key: 'framing_sentence',
    // Announces what follows rather than asserting something checkable.
    test: (t) =>
      /^(?:The (?:practical |key |main |primary )?(?:difference|point|result|decision|design|distinction)\b[^.]{0,60}(?:follows|emerges|is not|matters)|Key \w+ (?:differences|points) follow|This (?:design|approach) works well)\b/i.test(
        t.trim(),
      ),
    note: 'announces what follows rather than asserting something checkable',
  },
  {
    key: 'continuation_prose',
    test: () => true,
    note: 'an ordinary sentence continuing a point whose opening sentence carried the marker',
  },
];

export function shapeOf(sentence) {
  const text = String(sentence ?? '');
  for (const shape of SHAPES) if (shape.test(text)) return shape.key;
  return 'continuation_prose';
}

/** Every uncited factual sentence a source in the same run supports. */
export function missesFrom(report, variant = 'granular') {
  const out = [];
  for (const row of report.runs ?? []) {
    for (const [sampleIndex, sample] of (row.samples?.[variant] ?? []).entries()) {
      for (const uncited of sample.uncited_factual ?? []) {
        if (uncited.is_absence_disclosure) continue;
        if ((uncited.best_support ?? 0) < 0.5) continue;
        out.push({
          question: row.query,
          sample: sampleIndex + 1,
          sentence: uncited.sentence,
          best_support: uncited.best_support,
          shape: shapeOf(uncited.sentence),
        });
      }
    }
  }
  return out;
}

export function summarise(misses) {
  const counts = {};
  for (const m of misses) counts[m.shape] = (counts[m.shape] ?? 0) + 1;
  return counts;
}

export function render(report) {
  const L = [];
  const A = (line = '') => L.push(line);
  const total = report.misses.length;

  A('# What shape are the remaining citation misses?\n');
  A('> Uncited factual sentences that a source in the same run supports, from the');
  A(`> ${report.variant} arm of the evidence-replay A/B. Structural classification only.\n`);
  A(`- from: \`${report.ab_ran_at}\``);
  A(`- sentences: ${total}\n`);

  A('## By shape\n');
  A('| shape | sentences | share |');
  A('|---|---:|---:|');
  for (const [key, n] of Object.entries(report.counts).sort((a, b) => b[1] - a[1])) {
    A(`| ${key} | ${n} | ${((n / total) * 100).toFixed(0)}% |`);
  }
  A(`| **total** | **${total}** | |`);
  A('');
  for (const shape of SHAPES) {
    if (!report.counts[shape.key]) continue;
    A(`- \`${shape.key}\`: ${shape.note}`);
  }
  A('');

  A('## Every one of them\n');
  for (const [shapeKey] of Object.entries(report.counts).sort((a, b) => b[1] - a[1])) {
    A(`### ${shapeKey}\n`);
    for (const m of report.misses.filter((x) => x.shape === shapeKey)) {
      A(`- (${m.best_support}) ${m.sentence.replace(/\s+/g, ' ').slice(0, 150)}`);
    }
    A('');
  }
  return `${L.join('\n')}\n`;
}

function main() {
  const abPath = flag('ab', 'reports/prompt-ab.json');
  const variant = flag('variant', 'granular');
  const ab = JSON.parse(fs.readFileSync(abPath, 'utf8'));
  const misses = missesFrom(ab, variant);
  const report = { ab_ran_at: ab.ab_ran_at, variant, counts: summarise(misses), misses };

  const dir = path.dirname(abPath);
  fs.writeFileSync(path.join(dir, 'miss-shapes.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'miss-shapes.md'), render(report));
  console.log(`wrote ${dir}/miss-shapes.json and .md`);
  for (const [k, v] of Object.entries(report.counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
