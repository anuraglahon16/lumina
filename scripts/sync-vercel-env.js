#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';

/**
 * Push local configuration to a Vercel environment.
 *
 * This exists because parsing .env by hand went wrong in a way that was hard to
 * see. A value written as
 *
 *   TAVILY_API_KEY= "tvly-..."      # https://tavily.com
 *
 * has both quotes and a trailing comment, and stripping them in the wrong order
 * leaves the closing quote attached. The key was one character too long, the
 * provider answered 401, search fell through to the keyless fallback, and only
 * Deep Search noticed, because it was the only mode concurrent enough to get
 * that fallback rate-limited.
 *
 * So: no hand-parsing. dotenv reads the file exactly as the application does,
 * which makes "what is deployed" the same question as "what runs locally".
 *
 *   node scripts/sync-vercel-env.js [--env production] [--dry-run]
 */

const args = process.argv.slice(2);
const target = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'production';
const dryRun = args.includes('--dry-run');

/** Everything the deployment needs. Anything absent locally is skipped, not blanked. */
const KEYS = [
  'ANTHROPIC_API_KEY',
  'TAVILY_API_KEY',
  'VOYAGE_API_KEY',
  'OPENAI_API_KEY',
  'MONGODB_URI',
  'MONGODB_DB',
  'VECTOR_BACKEND',
  'VECTOR_DIM',
  'DEMO_PASSWORD',
  'AUTH_SECRET',
  'LUMINA_MODEL',
  'LUMINA_BRANCH_MODEL',
  'LUMINA_FAST_MODEL',
  'QUICK_MAX_ITERATIONS',
  'QUICK_MAX_TOOL_CALLS',
  'QUICK_MAX_FETCHES',
  'QUICK_WALL_CLOCK_MS',
  'SEARCH_PROVIDER',
  'EMBEDDING_PROVIDER',
];

const envPath = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error('No .env found. Copy .env.example and fill it in first.');
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envPath));

/**
 * A value that still carries a quote or a comment marker did not survive
 * parsing intact. Refusing to push it is the whole point: a malformed key
 * deployed is a 401 somewhere far away from here.
 */
function suspicious(value) {
  if (/^["']|["']$/.test(value)) return 'has a stray quote';
  if (/\s#\s/.test(value)) return 'still contains a comment';
  if (value !== value.trim()) return 'has surrounding whitespace';
  return null;
}

let pushed = 0;
let skipped = 0;
let refused = 0;

for (const key of KEYS) {
  const value = parsed[key];
  if (value === undefined || value === '') {
    skipped += 1;
    continue;
  }

  const problem = suspicious(value);
  if (problem) {
    console.error(`  REFUSED ${key}: ${problem}. Fix the value in .env and re-run.`);
    refused += 1;
    continue;
  }

  if (dryRun) {
    console.log(`  would push ${key} (${value.length} chars)`);
    pushed += 1;
    continue;
  }

  try {
    execFileSync('npx', ['--yes', 'vercel@latest', 'env', 'add', key, target, '--force'], {
      input: value, // never on the command line, where it would reach the shell history
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    console.log(`  pushed  ${key} (${value.length} chars)`);
    pushed += 1;
  } catch {
    console.error(`  FAILED  ${key}`);
    refused += 1;
  }
}

console.log(`\n${pushed} pushed, ${skipped} not set locally, ${refused} refused.`);
if (refused) process.exit(1);
console.log(dryRun ? 'Dry run. Re-run without --dry-run to apply.' : `Run "npx vercel --prod" to deploy with these.`);
