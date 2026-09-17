import { tokenize } from '../services/embeddings.js';

/**
 * Is there enough here to answer, or should the loop keep working?
 *
 * The naive version of this is a source count, and a count is wrong in both
 * directions. Two pages from the same site quoting the same press release are
 * one source wearing two hats. One thorough primary document can be plenty. A
 * question about this week answered from a page written in 2019 has evidence
 * that is abundant and useless.
 *
 * So coverage is judged on what the evidence actually is: how many independent
 * publishers it comes from, how much of the question's vocabulary it touches,
 * whether anything was read first-hand rather than summarised, and whether it
 * is recent enough for what was asked. The result carries the reasons, because
 * "not yet" needs to say what is missing or the loop cannot act on it.
 */

const STOP = new Set(
  ('the a an and or of in on at to for with from by as is are was were be been being it its this that these those what which who whom how why when where ' +
    'can could should would may might will shall do does did not no yes i you he she they we us our your their my me him her them there here about into over ' +
    'under after before between during such only very more most some any each other than then also new latest current').split(' '),
);

const contentWords = (text) => new Set(tokenize(String(text ?? '')).filter((w) => w.length > 2 && !STOP.has(w)));

/** Signals that the answer depends on something recent. */
const TIME_SENSITIVE = /\b(?:today|now|current|currently|latest|newest|recent|recently|this (?:week|month|year)|as of|so far|right now|still|202\d|up to date|nowadays)\b/i;

/** A publisher, not a URL: two pages on one site are not two witnesses. */
function publisherOf(source) {
  if (source.type === 'document' || source.type === 'doc') return `doc:${source.doc_id ?? source.docId ?? source.title}`;
  try {
    const host = new URL(source.url).hostname.replace(/^www\./, '');
    // Group by registrable-ish suffix so docs.example.com and example.com count once.
    const parts = host.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : host;
  } catch {
    return source.url || source.title || 'unknown';
  }
}

/**
 * Pages that merely aggregate others are weaker evidence for a factual claim
 * than the thing they aggregate. Not excluded — a search result page is still a
 * lead, and sometimes the aggregator is the primary source — but not counted as
 * independent corroboration on its own.
 */
const SECONDARY = /(?:^|\.)(?:wikipedia\.org|reddit\.com|quora\.com|medium\.com|pinterest\.|facebook\.com|x\.com|twitter\.com)$/i;

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
    if (!publishers.has(key)) publishers.set(key, { primary: !SECONDARY.test(key), sources: [] });
    publishers.get(key).sources.push(s);
  }
  const independent = publishers.size;
  const primaries = [...publishers.values()].filter((p) => p.primary).length;

  // How much of what was asked appears anywhere in what was read. A high number
  // is not proof the answer is there, but a low one is good evidence it is not.
  const asked = contentWords(query);
  const covered = new Set();
  const corpus = contentWords(usable.map(textOf).join(' '));
  for (const term of asked) if (corpus.has(term)) covered.add(term);
  const termCoverage = asked.size ? covered.size / asked.size : 1;

  const timeSensitive = TIME_SENSITIVE.test(query);
  let freshEnough = true;
  if (timeSensitive) {
    const cutoff = Date.now() - freshnessDays * 24 * 3600 * 1000;
    const dated = usable.map((s) => Date.parse(s.published_at || '')).filter((t) => Number.isFinite(t));
    // Undated evidence is not disqualifying — most pages carry no date — but
    // if everything that *is* dated predates the cutoff, the question has been
    // answered from history.
    freshEnough = dated.length === 0 || dated.some((t) => t >= cutoff);
    if (!freshEnough) reasons.push('the question asks about now and every dated source predates the window');
  }

  if (independent < minPublishers) reasons.push(`only ${independent} independent publisher${independent === 1 ? '' : 's'}`);
  if (termCoverage < minTermCoverage) reasons.push(`the evidence touches ${Math.round(termCoverage * 100)}% of what was asked`);
  if (!primaries) reasons.push('nothing read first-hand, only aggregators');

  // A single thorough primary source that covers the question is enough. Asking
  // for a second publisher regardless would send the loop looking for
  // corroboration of something already well established, which costs a fetch
  // and usually finds the same press release.
  const strongSingle = independent === 1 && primaries === 1 && termCoverage >= 0.75;
  const ok = freshEnough && (strongSingle || (independent >= minPublishers && termCoverage >= minTermCoverage && primaries >= 1));

  return {
    ok,
    usable: usable.length,
    publishers: independent,
    primaries,
    termCoverage: Number(termCoverage.toFixed(3)),
    timeSensitive,
    freshEnough,
    reasons: ok ? [] : reasons.length ? reasons : ['the evidence does not cover the question'],
  };
}
