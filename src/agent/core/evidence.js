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
      snippet: (page.description || candidate?.snippet || page.text?.slice(0, 300) || '').slice(0, 400),
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

    let citedSentences = 0;
    let supportedSentences = 0;
    const weak = [];

    for (const sentence of sentences) {
      const refs = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) =>
        m[1].split(',').map((x) => Number(x.trim())),
      );
      if (!refs.length) continue;
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
      if (best >= 0.5) supportedSentences += 1;
      else weak.push({ sentence: sentence.slice(0, 240), refs, support: Number(best.toFixed(2)) });
    }

    const uniqueCited = [...new Set(seen)].sort((a, b) => a - b);
    return {
      answer: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      cited: uniqueCited,
      uncited_sources: this.sources.filter((s) => !uniqueCited.includes(s.n)).map((s) => s.n),
      invalid_citations: invalid,
      cited_sentences: citedSentences,
      supported_sentences: supportedSentences,
      weak_citations: weak,
      groundedness: citedSentences ? Number((supportedSentences / citedSentences).toFixed(3)) : null,
    };
  }
}
