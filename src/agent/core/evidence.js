import { tokenize } from '../services/embeddings.js';
import { chunkPassages } from '../services/chunker.js';

const STOPWORDS = new Set(
  'the a an and or but if then than that this these those of in on at to for with from by as is are was were be been being it its it\'s they them their there here what which who whom how why when where can could should would may might will shall do does did not no yes we you i he she his her our your my me us also more most some any each other into over under about after before between during such only very'.split(' '),
);

const contentWords = (text) => new Set(tokenize(text).filter((t) => !STOPWORDS.has(t)));

/**
 * Split an answer into sentences for citation scoring.
 *
 * The answer is markdown, and markdown hides sentence boundaries from a naive
 * splitter: a paragraph opening with "**Bold**" does not start with a capital
 * letter, so "...partial.*\n\n**In and around..." reads as one sentence. That
 * matters because a merged sentence pools its words against a single citation
 * and scores as unsupported, which penalised the capped-run disclaimer, making
 * groundedness fall precisely when the answer was most honest about its limits.
 *
 * So: break on paragraph and list boundaries first, then on sentence-ending
 * punctuation, allowing emphasis and list markers on either side of the break.
 */
function splitSentences(text) {
  return text
    .split(/\n{2,}|\n(?=\s*(?:[-*+]|\d+[.)])\s)/)
    .flatMap((block) => block.split(/(?<=[.!?])["')\]]*[*_]*\s+(?=[*_#>\-]*\s*[A-Z0-9"'(\[])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this sentence make a claim about the *evidence* rather than about the
 * world?
 *
 * "The sources do not say when the meeting took place" and "The report found no
 * evidence of a breach [1]" look alike to a bag-of-words scorer, but only the
 * second is a citable claim. The first describes a gap in what was read, and a
 * citation attached to it points at a page that by construction cannot support
 * it: the reader follows the marker expecting corroboration and finds a page
 * about something else. That is exactly the failure citations exist to prevent,
 * so it is removed from the answer rather than scored as a weak citation.
 *
 * The test is deliberately narrow. It fires only when the subject is the
 * evidence itself, so a negative finding reported *by* a source keeps its
 * citation.
 */
/**
 * The patterns require the evidence term to be the *subject* of the negation,
 * not merely present in the sentence. "The audit found no evidence of a breach"
 * contains both an evidence word and a negation and is a perfectly citable
 * claim; "the sources do not say" is the same words in the arrangement that
 * makes the citation meaningless. Adjacency is what separates them.
 */
const ABSENCE_PATTERNS = [
  // "none of the sources", "no page", "neither result"
  /\b(?:no|none|neither)\s+(?:of\s+(?:the|these|those)\s+)?(?:sources?|pages?|results?|documents?|excerpts?)\b/i,
  // "nothing in the material I read"
  /\bnothing\s+(?:in|among|from|within)\s+(?:the\s+)?(?:sources?|results?|pages?|documents?|evidence|material)\b/i,
  // "the search results do not cover", "the evidence I read is silent on"
  new RegExp(
    String.raw`\b(?:the\s+)?(?:sources?|search\s+results?|results?\s+returned|pages?(?:\s+(?:I|we)\s+(?:read|fetched|retrieved))?` +
      String.raw`|documents?\s+(?:I|we)\s+(?:read|retrieved)|evidence(?:\s+(?:I|we)\s+(?:found|gathered|read|retrieved))?` +
      String.raw`|material\s+(?:I|we)\s+(?:read|found)|available\s+(?:evidence|sources?|material|information|record))\s+` +
      String.raw`(?:\w+\s+){0,3}?(?:do(?:es)?\s+not|did\s+not|don't|doesn't|didn't|are\s+silent|is\s+silent|contains?\s+no` +
      String.raw`|includes?\s+no|provides?\s+no|offers?\s+no|lacks?|fails?\s+to|failed\s+to|cannot|can't|could\s+not)\b`,
    'i',
  ),
  // "I could not find", "we were unable to locate"
  /\b(?:I|we)\s+(?:was|were)?\s*(?:unable\s+to|could\s+not|couldn't|did\s+not|didn't)\s+(?:find|locate|retrieve|access|confirm)\b/i,
];

function isClaimAboutEvidence(sentence) {
  const text = sentence.replace(/\[[\d,\s]+\]/g, ' ').replace(/\s+/g, ' ');
  return ABSENCE_PATTERNS.some((re) => re.test(text));
}

/**
 * The evidence ledger is the single source of truth for citations.
 *
 * Rule enforced here: a web search result is a *candidate*, not evidence. It
 * only becomes citable after the page is actually fetched and its text
 * extracted. Document chunks are citable on retrieval because the text is
 * already in hand. Nothing else can ever be cited.
 */
export class EvidenceLedger {
  constructor() {
    this.sources = [];
    this.byUrl = new Map();
    this.candidates = new Map(); // url -> search result seen but not (yet) fetched
    // Every url this run has tried to read, whether or not it yielded anything.
    // A second attempt reaches for leads that were never tried rather than
    // retrying one that already failed the same way.
    this.attempted = new Set();
  }

  /** Record search hits so the trace shows what was considered but not read. */
  noteCandidates(results) {
    for (const r of results) {
      if (!this.candidates.has(r.url) && !this.byUrl.has(r.url)) this.candidates.set(r.url, r);
    }
  }

  get citable() {
    return this.sources;
  }

  addWebSource(page, { branch = null, query = null } = {}) {
    const key = page.final_url || page.url;
    const existing = this.byUrl.get(key);
    if (existing) {
      if (branch && !existing.branches.includes(branch)) existing.branches.push(branch);
      return existing;
    }
    const candidate = this.candidates.get(page.url) || this.candidates.get(key);
    const source = {
      n: this.sources.length + 1,
      id: `s${this.sources.length + 1}`,
      type: 'web',
      title: page.title || candidate?.title || key,
      url: key,
      domain: (() => {
        try {
          return new URL(key).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })(),
      published_at: page.published_at || candidate?.published_at || null,
      author: page.author || null,
      // Verbatim from the text this source was actually read from, never the
      // page's own meta description or the search result's snippet. Those are
      // written to sell a click, they are not always in the page at all, and a
      // reader who follows a citation to check a claim must land on the words
      // the claim was drawn from. Scoring already used the fetched passages;
      // this makes what the reader is shown agree with what was measured.
      snippet: (page.text || '').trim().slice(0, 400),
      passages: chunkPassages(page.text || '').slice(0, 8),
      fetched_at: page.fetched_at || new Date().toISOString(),
      from_cache: Boolean(page.cached),
      truncated: Boolean(page.truncated),
      discovered_by: query,
      branches: branch ? [branch] : [],
      locator: null,
    };
    source._terms = contentWords(source.passages.join(' '));
    this.sources.push(source);
    this.byUrl.set(key, source);
    this.candidates.delete(page.url);
    return source;
  }

  addDocumentSource(chunk, { branch = null, query = null } = {}) {
    const key = `doc:${chunk.chunk_id}`;
    const existing = this.byUrl.get(key);
    if (existing) return existing;
    const source = {
      n: this.sources.length + 1,
      id: `s${this.sources.length + 1}`,
      type: 'document',
      title: chunk.filename,
      url: null,
      doc_id: chunk.doc_id,
      chunk_id: chunk.chunk_id,
      page: chunk.page,
      locator: chunk.page_label,
      domain: 'uploaded document',
      snippet: chunk.text.slice(0, 400),
      passages: [chunk.text],
      score: chunk.score,
      discovered_by: query,
      branches: branch ? [branch] : [],
      fetched_at: new Date().toISOString(),
    };
    source._terms = contentWords(chunk.text);
    this.sources.push(source);
    this.byUrl.set(key, source);
    return source;
  }

  /** Numbered evidence blocks handed to the synthesis prompt. */
  renderForPrompt({ maxCharsPerSource = 4500 } = {}) {
    return this.sources
      .map((s) => {
        const head =
          s.type === 'web'
            ? `[${s.n}] ${s.title}\nURL: ${s.url}${s.published_at ? `\nPublished: ${s.published_at}` : ''}`
            : `[${s.n}] ${s.title}, ${s.locator}\nSource: uploaded document`;
        const body = s.passages.join('\n\n').slice(0, maxCharsPerSource);
        return `${head}\nEVIDENCE:\n${body}`;
      })
      .join('\n\n---\n\n');
  }

  /** Shape sent to the client in the `sources` SSE event (no internals). */
  publicSources() {
    return this.sources.map((s) => ({
      n: s.n,
      id: s.id,
      type: s.type,
      title: s.title,
      url: s.url,
      domain: s.domain,
      locator: s.locator,
      page: s.page ?? null,
      doc_id: s.doc_id ?? null,
      snippet: s.snippet,
      published_at: s.published_at ?? null,
      from_cache: Boolean(s.from_cache),
      branches: s.branches,
    }));
  }

  publicCandidates() {
    return [...this.candidates.values()].map((c) => ({
      title: c.title,
      url: c.url,
      domain: c.domain,
      snippet: c.snippet,
      status: 'not_read',
    }));
  }

  /**
   * Validate an answer against the ledger.
   *
   * - Citation indices outside the ledger are stripped (a hallucinated source
   *   number must never reach the user).
   * - Each cited sentence is scored for lexical support against the source it
   *   cites; the ratio is reported as `groundedness`.
   */
  validate(answer) {
    const valid = new Set(this.sources.map((s) => s.n));
    const seen = [];
    const invalid = [];

    const cleaned = answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, group) => {
      const nums = group.split(',').map((x) => Number(x.trim()));
      const kept = nums.filter((n) => valid.has(n));
      invalid.push(...nums.filter((n) => !valid.has(n)));
      seen.push(...kept);
      return kept.length ? `[${kept.join(', ')}]` : '';
    });

    const sentences = splitSentences(cleaned);

    // Citations on statements about the evidence's own gaps are removed before
    // scoring: see isClaimAboutEvidence. `stripped` is reported so the trace
    // shows it happened rather than the marker silently vanishing.
    const strippedForAbsence = [];

    let citedSentences = 0;
    let supportedSentences = 0;
    const weak = [];
    const sentenceResults = [];

    for (const sentence of sentences) {
      const refs = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) =>
        m[1].split(',').map((x) => Number(x.trim())),
      );
      if (!refs.length) continue;
      if (isClaimAboutEvidence(sentence)) {
        strippedForAbsence.push({ sentence, refs });
        continue;
      }
      citedSentences += 1;
      const claimTerms = contentWords(sentence.replace(/\[[\d,\s]+\]/g, ''));
      if (claimTerms.size === 0) {
        supportedSentences += 1;
        continue;
      }
      let best = 0;
      for (const n of refs) {
        const source = this.sources.find((s) => s.n === n);
        if (!source) continue;
        let overlap = 0;
        for (const term of claimTerms) if (source._terms.has(term)) overlap += 1;
        best = Math.max(best, overlap / claimTerms.size);
      }
      // Half the claim's content words appearing in the cited source is a
      // deliberately loose bar: it catches citations pointing at the wrong
      // source, not paraphrase.
      const supported = best >= 0.5;
      if (supported) supportedSentences += 1;
      else weak.push({ sentence: sentence.slice(0, 240), refs, support: Number(best.toFixed(2)) });

      // Every decision, with the text it was made against. A support score is
      // not interpretable without it, and a diagnostic that re-derives the
      // evidence from somewhere else is grading a different thing from the
      // validator it is supposed to be explaining.
      sentenceResults.push({
        sentence: sentence.slice(0, 400),
        refs,
        supported,
        best_score: Number(best.toFixed(3)),
        // Every passage, whole. The score is computed from the source's full
        // term set, so keeping four of eight — or truncating one — can omit the
        // very text that produced the number, and a classifier reading the
        // remainder concludes the claim was unsupported when it was not.
        // Bounded already: the chunker caps a source at eight passages.
        scored_against: refs
          .map((n) => this.sources.find((s) => s.n === n))
          .filter(Boolean)
          .map((s) => ({ n: s.n, chars: s.passages.join(' ').length, passages: s.passages })),
      });
    }

    // Each offending sentence is edited where it sits. Rebuilding the answer by
    // rejoining the split would be simpler and wrong: splitSentences breaks on
    // paragraph and list boundaries, so a rejoin flattens the markdown.
    let output = cleaned;
    for (const { sentence } of strippedForAbsence) {
      const at = output.indexOf(sentence);
      if (at === -1) continue; // truncated for reporting; leave it rather than guess
      output = output.slice(0, at) + sentence.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '') + output.slice(at + sentence.length);
    }
    if (strippedForAbsence.length) {
      // `seen` still counts a source cited elsewhere in the answer; one that was
      // cited *only* on a stripped sentence is no longer cited at all.
      const survives = new Set(
        [...output.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim()))),
      );
      for (let i = seen.length - 1; i >= 0; i -= 1) if (!survives.has(seen[i])) seen.splice(i, 1);
    }

    const uniqueCited = [...new Set(seen)].sort((a, b) => a - b);
    return {
      answer: output.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      cited: uniqueCited,
      uncited_sources: this.sources.filter((s) => !uniqueCited.includes(s.n)).map((s) => s.n),
      invalid_citations: invalid,
      cited_sentences: citedSentences,
      supported_sentences: supportedSentences,
      weak_citations: weak,
      sentence_results: sentenceResults,
      stripped_for_absence: strippedForAbsence,
      groundedness: citedSentences ? Number((supportedSentences / citedSentences).toFixed(3)) : null,
    };
  }
}
