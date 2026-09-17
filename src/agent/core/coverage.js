import { parse as parseDomain } from 'tldts';
import { tokenize } from '../services/embeddings.js';

/**
 * Is there enough here to answer, or should the loop keep working?
 *
 * The naive version of this is a source count, and a count is wrong in both
 * directions. Two pages from the same site quoting the same press release are
 * one source wearing two hats. One thorough document can be plenty. A
 * question about this week answered from a page written in 2019 has evidence
 * that is abundant and useless.
 *
 * So coverage is judged on what the evidence actually is: how many independent
 * publishers it comes from, how much of the question's vocabulary it touches,
 * whether anything came from somewhere other than an aggregator, and whether a
 * question about now was answered from something datably recent. The result
 * carries its reasons, because "not yet" has to say what is missing or the loop
 * cannot act on it.
 *
 * What this deliberately does not claim to judge is authority. Telling an
 * official specification from a content farm needs to know what the question is
 * about, and that judgement belongs to synthesis, with the evidence in hand.
 */

const STOP = new Set(
  ('the a an and or of in on at to for with from by as is are was were be been being it its this that these those what which who whom how why when where ' +
    'can could should would may might will shall do does did not no yes i you he she they we us our your their my me him her them there here about into over ' +
    'under after before between during such only very more most some any each other than then also new latest current').split(' '),
);

const contentWords = (text) => new Set(tokenize(String(text ?? '')).filter((w) => w.length > 2 && !STOP.has(w)));

/** Signals that the answer depends on something recent. */
const TIME_SENSITIVE = /\b(?:today|now|current|currently|latest|newest|recent|recently|this (?:week|month|year)|as of|so far|right now|still|202\d|up to date|nowadays)\b/i;

/**
 * A publisher, not a URL: two pages on one site are not two witnesses.
 *
 * Grouped by registrable domain from the Public Suffix List rather than by the
 * last two labels of the hostname. The shortcut is wrong wherever the suffix is
 * itself multi-part: it reduced bbc.co.uk and theguardian.co.uk to "co.uk" and
 * counted two unrelated newspapers as one publisher, which understates
 * corroboration exactly where a question is likely to be contested.
 */
export function publisherOf(source) {
  if (source.type === 'document' || source.type === 'doc') return `doc:${source.doc_id ?? source.docId ?? source.title}`;
  const parsed = parseDomain(String(source.url ?? ''));
  return parsed?.domain || parsed?.hostname || source.url || source.title || 'unknown';
}

/**
 * Sites that mostly restate other sites.
 *
 * This is a list of known aggregators and nothing more. It is emphatically not
 * a test for primary sources: an SEO blog, a content farm and a copied press
 * release all pass it, and calling them "primary" would be a claim this check
 * cannot support. The field it feeds is named for what it actually measures.
 *
 * Judging real authority needs to know what the question is about — an official
 * specification, the standards body, the company's own filing — and that is a
 * judgement the synthesis model makes with the evidence in front of it, after
 * deterministic retrieval has already done the fast part.
 */
const AGGREGATOR = /(?:^|\.)(?:wikipedia\.org|reddit\.com|quora\.com|medium\.com|pinterest\.[a-z.]+|facebook\.com|x\.com|twitter\.com|tumblr\.com|substack\.com)$/i;

const textOf = (source) => [source.snippet, ...(source.passages || [])].filter(Boolean).join(' ');

/**
 * Score what has been gathered against what was asked.
 *
 * `ok` is the decision the caller acts on. Everything else is the reasoning,
 * kept so a trace can show why a run stopped researching or why it did not.
 */
export function assessCoverage(query, sources, { minPublishers = 2, minTermCoverage = 0.5, freshnessDays = 400 } = {}) {
  const usable = (sources || []).filter((s) => textOf(s).trim().length > 80);
  const reasons = [];

  if (!usable.length) {
    return { ok: false, publishers: 0, termCoverage: 0, reasons: ['nothing has been read yet'], usable: 0 };
  }

  const publishers = new Map();
  for (const s of usable) {
    const key = publisherOf(s);
    if (!publishers.has(key)) publishers.set(key, { nonAggregator: !AGGREGATOR.test(key), sources: [] });
    publishers.get(key).sources.push(s);
  }
  const independent = publishers.size;
  const nonAggregators = [...publishers.values()].filter((p) => p.nonAggregator).length;

  // How much of what was asked appears anywhere in what was read. A high number
  // is not proof the answer is there, but a low one is good evidence it is not.
  const asked = contentWords(query);
  const covered = new Set();
  const corpus = contentWords(usable.map(textOf).join(' '));
  for (const term of asked) if (corpus.has(term)) covered.add(term);
  const termCoverage = asked.size ? covered.size / asked.size : 1;

  /**
   * A question about now needs something that can be shown to be from now.
   *
   * Undated evidence used to satisfy this, on the reasoning that most pages
   * carry no date. That reasoning is right about pages and wrong about the
   * question: two undated pages could settle "what is the latest release" while
   * being years old, and nothing in the answer would say so. Absence of a date
   * is absence of evidence about recency, which is not the same as evidence of
   * recency.
   *
   * So at least one source has to carry a date inside the window. Failing that
   * the run is not finished, and the loop goes looking for one — which is a
   * round trip spent on the one question type where staleness is invisible in
   * the answer and wrong in the reader's hands.
   */
  const timeSensitive = TIME_SENSITIVE.test(query);
  let freshEnough = true;
  if (timeSensitive) {
    const cutoff = Date.now() - freshnessDays * 24 * 3600 * 1000;
    const dates = usable
      .map((s) => Date.parse(s.published_at || s.fetched_at || ''))
      .filter((t) => Number.isFinite(t));
    freshEnough = dates.some((t) => t >= cutoff);
    if (!freshEnough) {
      reasons.push(
        dates.length
          ? 'the question asks about now and every dated source predates the window'
          : 'the question asks about now and nothing read carries a date',
      );
    }
  }

  if (independent < minPublishers) reasons.push(`only ${independent} independent publisher${independent === 1 ? '' : 's'}`);
  if (termCoverage < minTermCoverage) reasons.push(`the evidence touches ${Math.round(termCoverage * 100)}% of what was asked`);
  if (!nonAggregators) reasons.push('everything read was an aggregator');

  // A single thorough source that covers the question is enough. Asking
  // for a second publisher regardless would send the loop looking for
  // corroboration of something already well established, which costs a fetch
  // and usually finds the same press release.
  const strongSingle = independent === 1 && nonAggregators === 1 && termCoverage >= 0.75;
  const ok = freshEnough && (strongSingle || (independent >= minPublishers && termCoverage >= minTermCoverage && nonAggregators >= 1));

  return {
    ok,
    usable: usable.length,
    publishers: independent,
    nonAggregators,
    termCoverage: Number(termCoverage.toFixed(3)),
    timeSensitive,
    freshEnough,
    reasons: ok ? [] : reasons.length ? reasons : ['the evidence does not cover the question'],
  };
}
