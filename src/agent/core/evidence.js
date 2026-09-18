import { tokenize } from '../services/embeddings.js';
import { chunkPassages } from '../services/chunker.js';
import { reorderPassages } from './passageOrder.js';
import { safeSlice } from '../../shared/text.js';

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
 *
 * Then put the citations back where they belong. The boundary rule admits `[`
 * as an opening character, so "...rows do. [1]" breaks *between* the claim and
 * its marker. What that produced was not one mangled sentence but two wrong
 * ones: a claim with no citation, counted as uncited, and a bare "[1]" with
 * refs and no words, counted as cited and — having no content to check —
 * counted as supported for free. Seven of those in a twenty-question run moved
 * pooled grounding across the 0.95 line in one direction and depressed
 * completeness in the other.
 *
 * Which claim a loose marker belongs to depends on where answers put them, and
 * the synthesis prompt does not say. It asks for "bracketed numbers matching
 * the evidence blocks" and leaves placement to the model, so both conventions
 * occur in real answers — often consistently within one answer and differently
 * between two. One run's columnar-storage answer trails every marker
 * ("...rows do. [1]"); its write-ahead-log answer leads every one of them
 * ("[1] Write-ahead logging is a family of techniques..."). A parser that
 * assumes either convention gets the other one systematically wrong, and
 * attaching a marker to the wrong claim is worse than not attaching it: it
 * scores a sentence against a source that was never offered for it.
 *
 * So placement is inferred rather than assumed. A marker with nothing after it
 * can only trail. A marker opening a block can only lead. Everything between
 * those follows whichever convention the rest of the answer demonstrably uses.
 * A marker with no claim on the side its convention points to is a real orphan
 * and is reported as one rather than silently scored.
 */

/** One or more citation markers at the very start of a fragment. */
const LEADING_MARKERS = /^(?:\[\d+(?:\s*,\s*\d+)*\]\s*)+/;
/** Whatever markdown opens a block: a list bullet, a number, a heading, a quote. */
const BLOCK_MARKUP = /^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s*/;
/** The split that separates paragraphs and list items. */
const BLOCK_BOUNDARY = /\n{2,}|\n(?=\s*(?:[-*+]|\d+[.)])\s)/;

/**
 * Where this answer puts its citation markers.
 *
 * Counted only from the placements that are unambiguous: a marker that opens a
 * block has nothing before it and must lead, and a marker that closes one has
 * nothing after it and must trail. Ambiguous markers in the middle are the ones
 * being decided, so letting them vote would be circular.
 *
 * Ties go to trailing, which is the more common convention and the one that
 * "Claim [1]." — the unambiguous in-sentence form — already follows.
 */
export function citationStyle(text) {
  let leading = 0;
  let trailing = 0;
  for (const block of String(text ?? '').split(BLOCK_BOUNDARY)) {
    const body = block.trim().replace(BLOCK_MARKUP, '');
    if (!body) continue;
    if (LEADING_MARKERS.test(body)) leading += 1;
    // A closing marker may be followed by sentence punctuation or a quote.
    if (/\[\d+(?:\s*,\s*\d+)*\]["')\]]*[.!?]?[*_]*$/.test(body)) trailing += 1;
  }
  return leading > trailing ? 'leading' : 'trailing';
}

/**
 * Sentences as ranges into the answer, not as detached strings.
 *
 * Reattachment has to extend a previous sentence to cover its marker, and
 * joining two trimmed strings with a guessed separator produces text that is
 * no longer a substring of the answer — which breaks the absence-stripping
 * pass below, since it finds the sentence it must edit by `indexOf`. Extending
 * a range cannot have that problem: every sentence is a real slice.
 */
export function locateSentences(text) {
  const pieces = [];
  for (const [index, block] of String(text ?? '').split(BLOCK_BOUNDARY).entries()) {
    for (const piece of block.split(/(?<=[.!?])["')\]]*[*_]*\s+(?=[*_#>\-]*\s*[A-Z0-9"'(\[])/)) {
      const trimmed = piece.trim();
      // The block index is what "the same block" means. A blank line is not
      // enough to tell: two list items are separated by a single newline, and
      // a marker opening the second one does not belong to the first.
      if (trimmed) pieces.push({ text: trimmed, block: index });
    }
  }

  // The pieces are substrings of `text` in order, so a forward cursor locates
  // each one unambiguously even when the same words repeat later.
  const located = [];
  let cursor = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece.text, cursor);
    if (at === -1) {
      located.push({ ...piece, start: null, end: null });
      continue;
    }
    located.push({ ...piece, start: at, end: at + piece.text.length });
    cursor = at + piece.text.length;
  }

  return reattachCitations(located, text, citationStyle(text));
}

/** Give each loose marker to the claim the answer's own convention points at. */
function reattachCitations(sentences, text, style) {
  const out = [];
  for (const sentence of sentences) {
    const lead = sentence.text.match(LEADING_MARKERS);
    if (!lead) {
      out.push(sentence);
      continue;
    }
    const markers = lead[0].trimEnd();
    const rest = sentence.text.slice(lead[0].length).trim();
    const previous = out.at(-1);
    const hasClaimBefore = previous && !previous.orphan && previous.block === sentence.block && previous.end !== null;

    // A marker with text after it in the same fragment leads that text whenever
    // nothing precedes it in the block, and otherwise follows the answer's own
    // convention. A marker with nothing after it can only trail.
    const leads = rest && (!hasClaimBefore || style === 'leading');
    if (leads) {
      out.push(sentence);
      continue;
    }

    if (hasClaimBefore && sentence.start !== null) {
      previous.end = sentence.start + markers.length;
      previous.text = text.slice(previous.start, previous.end);
    } else {
      // Nothing on the side the convention points at. Reported, never scored.
      out.push({
        text: markers,
        block: sentence.block,
        start: sentence.start,
        end: sentence.start === null ? null : sentence.start + markers.length,
        orphan: true,
      });
    }

    if (!rest) continue;
    const start = sentence.start === null ? null : text.indexOf(rest, sentence.start);
    out.push({ text: rest, block: sentence.block, start, end: start === null ? null : start + rest.length });
  }
  return out;
}

/** The sentences themselves, for callers that do not need the offsets. */
export function splitSentences(text) {
  return locateSentences(text).map((s) => s.text);
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

export function isClaimAboutEvidence(sentence) {
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
      snippet: safeSlice((page.text || '').trim(), 400),
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

  /**
   * Rebuild a source from passages a finished run saved, for offline rescoring.
   *
   * When a scoring defect is found after a run, the choice is to re-ask twenty
   * questions — a different sample against a moved web, costing real money and
   * answering a different question — or to re-score what was already recorded.
   * Only the second isolates the change to the validator.
   *
   * This exists so that rescoring uses the ledger's own term construction
   * rather than a copy of it in a tool. A rescorer that builds its own term sets
   * grades something subtly different from the thing it claims to be correcting,
   * which is how a diagnostic once reported 0.19 for a system measuring 0.86.
   *
   * `passages` must be the saved `extracted_passages`: the funnel records
   * exactly `chunkPassages(text).slice(0, 8)`, which is exactly what
   * `addWebSource` stores, so the reconstructed term set is identical rather
   * than merely similar.
   */
  restoreWebSource({ n, url, title = null, passages = [], snippet = '', published_at = null }) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`a restored source needs the number it had in the run, got ${n}`);
    if (this.sources.some((s) => s.n === n)) throw new Error(`source ${n} has already been restored`);
    const source = {
      n,
      id: `s${n}`,
      type: 'web',
      title: title || url,
      url,
      domain: (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })(),
      published_at,
      author: null,
      snippet,
      passages,
      fetched_at: null,
      from_cache: false,
      truncated: false,
      discovered_by: null,
      branches: [],
      locator: null,
      restored: true,
    };
    source._terms = contentWords(source.passages.join(' '));
    this.sources.push(source);
    this.sources.sort((a, b) => a.n - b.n);
    this.byUrl.set(url, source);
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
  /**
   * The evidence as the model sees it, best passages first.
   *
   * There is a cap of 4500 characters per source, and the pages this system
   * reads run to ten thousand. More than half of every long source was
   * therefore never shown to the model — and *which* half was decided by
   * extraction order, which is the order text appears on the page and has
   * nothing to do with the question.
   *
   * That is not a subtle loss. Three questions in a twenty-question replay were
   * answered with "the evidence does not cover this": certificate pinning,
   * what the borrow checker prevents, and why HTTP/3 avoids head-of-line
   * blocking. In all three the answer was *correct about its prompt* and the
   * text that answered the question was sitting in the ledger, past the cut.
   * The page's navigation menu made it in; the answer did not.
   *
   * So the passages are ordered by how much of the question they speak to
   * before the cap applies. The cap still applies — a Quick request pays for
   * every character of it in time to first token — but what survives it is now
   * chosen by relevance rather than by where the extractor happened to stop.
   *
   * Ordering changes nothing about scoring. `_terms` is built from the whole
   * passage set and is order-independent, so groundedness measures exactly what
   * it measured before.
   *
   * `query` is optional only so that a caller with no question still gets
   * sensible output; without it this is the old behaviour, and the returned
   * `dropped_chars` says what that cost.
   */
  renderForPrompt({ maxCharsPerSource = 4500, query = null } = {}) {
    const dropped = [];
    const text = this.sources
      .map((s) => {
        const head =
          s.type === 'web'
            ? `[${s.n}] ${s.title}\nURL: ${s.url}${s.published_at ? `\nPublished: ${s.published_at}` : ''}`
            : `[${s.n}] ${s.title}, ${s.locator}\nSource: uploaded document`;
        const ordered = query ? reorderPassages(s.passages, query, 'relevance').map((p) => p.text) : s.passages;
        const whole = ordered.join('\n\n');
        const body = safeSlice(whole, maxCharsPerSource);
        if (whole.length > body.length) dropped.push({ n: s.n, kept: body.length, dropped: whole.length - body.length });
        return `${head}\nEVIDENCE:\n${body}`;
      })
      .join('\n\n---\n\n');

    // Attached rather than returned separately, so an existing caller that
    // treats this as a string keeps working and one that wants to know what was
    // thrown away can ask.
    return Object.assign(new String(text), { dropped_sources: dropped });
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
   * How well one sentence is supported by the best source in this ledger.
   *
   * The same measurement `validate` applies to cited sentences, exposed for
   * *uncited* ones. Whether an uncited claim was supported anyway is the single
   * most useful thing to know about a completeness gap — "the answer did not
   * cite evidence it had" and "the answer asserted something nothing supports"
   * are different problems — and re-deriving the score in a tool would grade it
   * against a different term set from the one the validator uses.
   */
  scoreSentence(sentence) {
    const terms = contentWords(String(sentence ?? '').replace(/\[[\d,\s]+\]/g, ''));
    if (!terms.size) return null;
    let best = 0;
    for (const source of this.sources) {
      let overlap = 0;
      for (const term of terms) if (source._terms.has(term)) overlap += 1;
      best = Math.max(best, overlap / terms.size);
    }
    return Number(best.toFixed(3));
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

    const located = locateSentences(cleaned);

    // Citations on statements about the evidence's own gaps are removed before
    // scoring: see isClaimAboutEvidence. `stripped` is reported so the trace
    // shows it happened rather than the marker silently vanishing.
    const strippedForAbsence = [];
    // A marker with no claim to attach to, and a cited sentence with nothing
    // checkable in it. Neither can be scored, so neither is counted in either
    // direction — but both are reported, because the alternative to counting
    // them honestly is not counting them at all.
    const orphanCitations = [];
    const unscoreable = [];

    let citedSentences = 0;
    let supportedSentences = 0;
    const weak = [];
    const sentenceResults = [];

    for (const located_ of located) {
      const sentence = located_.text;
      const refs = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) =>
        m[1].split(',').map((x) => Number(x.trim())),
      );
      if (!refs.length) continue;
      if (located_.orphan) {
        orphanCitations.push({ marker: sentence, refs });
        continue;
      }
      if (isClaimAboutEvidence(sentence)) {
        strippedForAbsence.push({ sentence, refs });
        continue;
      }
      const claimTerms = contentWords(sentence.replace(/\[[\d,\s]+\]/g, ''));
      if (claimTerms.size === 0) {
        // Nothing to score against. Counting it supported invents a pass and
        // counting it unsupported invents a failure; it is neither, and saying
        // so is the only honest option.
        unscoreable.push({ sentence: sentence.slice(0, 240), refs, reason: 'no content words to score' });
        continue;
      }
      citedSentences += 1;
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

    // The invariant the counts depend on. `cited_sentences` is the denominator
    // of groundedness and `sentence_results` is the only record of how each one
    // was judged; a number larger than the record it summarises is a number
    // nobody can check, which is exactly how seven unaudited free supports got
    // into a published figure.
    if (sentenceResults.length !== citedSentences) {
      throw new Error(
        `citation accounting is inconsistent: ${citedSentences} cited sentences but ${sentenceResults.length} recorded decisions. ` +
          'Every counted sentence must carry the decision that counted it.',
      );
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
      orphan_citations: orphanCitations,
      unscoreable_citations: unscoreable,
      groundedness: citedSentences ? Number((supportedSentences / citedSentences).toFixed(3)) : null,
    };
  }
}
