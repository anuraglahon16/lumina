import { tokenize } from '../services/embeddings.js';

/**
 * Put the passages that answer the question in front of the ones that do not.
 *
 * Adjudication of a twenty-question replay found nineteen of twenty-six
 * evidence-gap disclosures to be false: the answer said the evidence did not
 * cover the question while a passage held exactly what was asked. The borrow
 * checker page says "Prevents memory errors (use-after-free, dangling pointers,
 * etc.) at compile time"; the HTTP/3 page says QUIC "provides independent
 * streams at the transport layer, eliminating both TCP and HTTP/2 head-of-line
 * blocking". Both answers declined to answer.
 *
 * What those three cases share is position. The leading passages are site
 * navigation — "Machine Identity Security: The Definitive Guide", "What Is
 * Cert-Manager?", a cookie notice — and the substantive text sits at index 3 or
 * later. The hypothesis this module exists to test is that an answer judges an
 * evidence block by what it reads first.
 *
 * Nothing here calls a model or an embedding service. Quick's whole budget is
 * the reason: a reordering that costs a round trip is not a reordering, it is
 * another hop in front of the first token. Everything below is counting.
 */

const STOPWORDS = new Set(
  'the a an and or but if then than that this these those of in on at to for with from by as is are was were be been being it its they them their there here what which who whom how why when where can could should would may might will shall do does did not no yes we you i he she his her our your my me us also more most some any each other into over under about after before between during such only very'.split(
    ' ',
  ),
);

const words = (text) => tokenize(String(text ?? ''));
const contentWords = (text) => words(text).filter((t) => !STOPWORDS.has(t));

/**
 * How much of the question this passage actually speaks to.
 *
 * Content-word coverage, not term frequency: a navigation menu that repeats the
 * page title six times should not outrank a paragraph that answers the question
 * once. Coverage counts distinct question terms present, so repetition buys
 * nothing.
 */
export function queryCoverage(passage, query) {
  const asked = new Set(contentWords(query));
  if (!asked.size) return 0;
  const present = new Set(contentWords(passage));
  let hit = 0;
  for (const term of asked) if (present.has(term)) hit += 1;
  return hit / asked.size;
}

/**
 * Does this read like prose, or like a list of links?
 *
 * Function words are the signal. Written sentences are full of them — "of",
 * "that", "is", "to" — and navigation menus have almost none, because a menu is
 * a list of noun phrases. "Machine Identity Security: The Definitive Guide /
 * Four Pillars of Machine Identity Architecture" is nine content words and one
 * function word; a sentence of the same length runs closer to forty percent
 * function words.
 *
 * Sentence-ending punctuation is the second signal, for the same reason: menus
 * do not end in full stops.
 *
 * Length is deliberately not a signal. A table row, a formula, or a one-line
 * definition is short and is exactly the content worth reading, and a rule that
 * demoted short passages would bury the specification answers along with the
 * menus.
 */
export function prosiness(passage) {
  const all = words(passage);
  if (all.length < 4) return 0.5; // too little to judge; neither promoted nor buried
  const functionWords = all.filter((t) => STOPWORDS.has(t)).length / all.length;
  const text = String(passage ?? '');
  const terminals = (text.match(/[.!?](?:\s|$)/g) ?? []).length;
  // Per hundred words, capped: one full stop proves prose, thirty do not prove
  // it thirty times over.
  const punctuation = Math.min(1, terminals / Math.max(1, all.length / 100) / 4);
  return 0.7 * Math.min(1, functionWords / 0.3) + 0.3 * punctuation;
}

/**
 * The share of lines that stop without stopping.
 *
 * This is what actually separates a site menu from a paragraph, and function
 * words alone do not: a menu about certificate management still contains "of"
 * and "and", so it scores respectably on prosiness. What it never does is end
 * its lines. "Machine Identity Security: The Definitive Guide / Four Pillars of
 * Machine Identity Architecture / What Is Cert-Manager?" is three lines and
 * three missing full stops.
 *
 * The length bound matters. A long line without a full stop is a paragraph the
 * extractor cut mid-sentence, which is content; a short one is a link.
 */
export function fragmentRatio(passage) {
  const lines = String(passage ?? '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);
  if (!lines.length) return 0;
  const fragments = lines.filter((l) => l.length < 90 && !/[.!?]["')\]]*$/.test(l)).length;
  return fragments / lines.length;
}

/**
 * Digits, operators and units: a table or a formula rather than a menu.
 *
 * Kept apart from prosiness because these passages are deliberately not prose
 * and would score near zero on it. A specification line is low-prose and high
 * value, which is the exact combination a naive "demote the non-prose" rule
 * gets wrong.
 */
export function isStructuredContent(passage) {
  const text = String(passage ?? '');
  const digits = (text.match(/\d/g) ?? []).length / Math.max(1, text.length);
  const operators = (text.match(/[=<>×*/+%]|\bbytes\b|\bms\b|\bGB\b|\bKB\b/g) ?? []).length;
  return digits > 0.02 || operators >= 2;
}

/** Every feature, so a ranking can be argued with rather than trusted. */
export function features(passage, query) {
  const coverage = queryCoverage(passage, query);
  const prose = prosiness(passage);
  const structured = isStructuredContent(passage);
  const fragments = fragmentRatio(passage);
  return {
    query_coverage: Number(coverage.toFixed(3)),
    prosiness: Number(prose.toFixed(3)),
    fragment_ratio: Number(fragments.toFixed(3)),
    structured_content: structured,
    chars: String(passage ?? '').length,
    // Mostly unterminated short lines, no figures to suggest a table, and it
    // barely touches the question. All three, because the first two alone get
    // it wrong in a way this experiment caught immediately: the borrow-checker
    // answer lives in a comparison table rendered as short unpunctuated lines
    // ("Prevents memory errors (use-after-free, dangling pointers, etc.) at
    // compile time"), which has no digits, looks exactly like a menu to the
    // first two tests, and covers every word of the question.
    //
    // Coverage is the guard. Burying a passage is a bet that it will not help,
    // and a passage carrying most of the question's terms is direct evidence
    // against that bet — whatever it looks like.
    navigation_like: fragments >= 0.6 && !structured && coverage < 0.6,
  };
}

export const ORDERINGS = {
  /** As extracted. The control. */
  original: (passages) => passages.map((text, i) => ({ text, from: i, features: null })),

  /** Most question coverage first, original order breaking ties. */
  relevance: (passages, query) =>
    passages
      .map((text, i) => ({ text, from: i, features: features(text, query) }))
      .sort((a, b) => b.features.query_coverage - a.features.query_coverage || a.from - b.from),

  /**
   * Substance first: anything that looks like navigation goes to the back,
   * and what remains is ordered by how much of the question it speaks to.
   *
   * The demotion is a partition rather than a penalty term. A weighted sum lets
   * a menu with the page title in it outscore a paragraph that answers the
   * question, because the title repeats the question's words — which is the
   * failure being fixed, reproduced arithmetically.
   */
  content_first: (passages, query) => {
    const scored = passages.map((text, i) => ({ text, from: i, features: features(text, query) }));
    const substantive = scored.filter((p) => !p.features.navigation_like);
    const rest = scored.filter((p) => p.features.navigation_like);
    const byCoverage = (a, b) => b.features.query_coverage - a.features.query_coverage || a.from - b.from;
    return [...substantive.sort(byCoverage), ...rest.sort(byCoverage)];
  },
};

/**
 * Reorder a source's passages, keeping every one of them.
 *
 * Removal is a different experiment. Dropping a passage changes what evidence
 * exists, so a result would not say whether order matters — it would say that
 * less noise helps, which is a separate and much less surprising claim.
 */
export function reorderPassages(passages, query, ordering = 'original') {
  const fn = ORDERINGS[ordering];
  if (!fn) throw new Error(`unknown ordering "${ordering}"; expected one of ${Object.keys(ORDERINGS).join(', ')}`);
  const ranked = fn(passages ?? [], query ?? '');
  if (ranked.length !== (passages ?? []).length) {
    throw new Error(`ordering "${ordering}" returned ${ranked.length} of ${passages.length} passages; reordering never drops one`);
  }
  return ranked.map((p, to) => ({ ...p, to }));
}
