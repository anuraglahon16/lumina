import { createHash } from 'node:crypto';
import { config } from '../../shared/config.js';
import { cached } from './cache.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('embeddings');

export function resolveEmbeddingProvider() {
  if (config.embeddings.provider !== 'auto') return config.embeddings.provider;
  if (config.embeddings.voyageKey) return 'voyage';
  if (config.embeddings.openaiKey) return 'openai';
  return 'local';
}

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'+.#-]*/g) || []).filter((t) => t.length > 1 && t.length < 40);
}

/**
 * Keyless fallback embedding: hashed bag-of-words with sublinear term
 * frequency, L2-normalised. It has no semantic generalisation. It is a
 * lexical vector, which is exactly why retrieval blends it with BM25 and why
 * `/v1/health` reports the active provider. Good enough to run the whole
 * system offline; swap in Voyage/OpenAI by setting one env var.
 */
function localEmbed(text) {
  const dim = config.embeddings.localDim;
  const vec = new Float64Array(dim);
  const tokens = tokenize(text);
  const counts = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    counts.set(tokens[i], (counts.get(tokens[i]) || 0) + 1);
    if (i > 0) {
      const bigram = `${tokens[i - 1]}_${tokens[i]}`;
      counts.set(bigram, (counts.get(bigram) || 0) + 1);
    }
  }
  for (const [term, count] of counts) {
    const h = createHash('sha1').update(term).digest();
    const idx = ((h[0] << 16) | (h[1] << 8) | h[2]) % dim;
    const sign = h[3] & 1 ? 1 : -1;
    vec[idx] += sign * (1 + Math.log(count));
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

async function voyageEmbed(texts, inputType) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embeddings.voyageKey}` },
    body: JSON.stringify({ model: config.embeddings.voyageModel, input: texts, input_type: inputType }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function openaiEmbed(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embeddings.openaiKey}` },
    body: JSON.stringify({ model: config.embeddings.openaiModel, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Embed a batch of texts, reporting which embedder actually produced them.
 *
 * The fallback used to happen per slice, which kept indexing alive and quietly
 * destroyed the index: a rate-limited document came back part remote vectors
 * and part local ones, in different spaces and often different dimensions, and
 * cosine similarity across that mixture is not a similarity. It did not error.
 * It returned a number, the document looked indexed, and recall was zero.
 *
 * So the choice of embedder is made once for the whole batch. Vectors compared
 * to each other are always from the same model, and `provider` tells the caller
 * which one, because a query has to be embedded the same way as the chunks it
 * is searched against.
 */
export async function embedBatch(texts, { inputType = 'document', recorder, provider: forced } = {}) {
  if (!texts.length) return { vectors: [], provider: forced || resolveEmbeddingProvider(), dim: 0 };
  // A query must be embedded by whatever embedded the chunks it will be
  // compared against, which is not always the current default.
  const provider = forced || resolveEmbeddingProvider();

  if (provider === 'local') {
    return { vectors: texts.map(localEmbed), provider: 'local', dim: config.embeddings.localDim };
  }

  try {
    const vectors = [];
    for (let i = 0; i < texts.length; i += config.embeddings.batchSize) {
      const slice = texts.slice(i, i + config.embeddings.batchSize);
      const { value } = await cached(
        'embed',
        { provider, inputType, texts: slice },
        config.cache.embedTtlMs,
        () => withRetry(() => (provider === 'voyage' ? voyageEmbed(slice, inputType) : openaiEmbed(slice))),
        recorder,
      );
      vectors.push(...value);
    }
    return { vectors, provider, dim: vectors[0]?.length || 0 };
  } catch (err) {
    // All of it, or none of it.
    log.warn('embedding_provider_failed_using_local', { provider, texts: texts.length, err: err.message });
    return { vectors: texts.map(localEmbed), provider: 'local', dim: config.embeddings.localDim };
  }
}

/**
 * Retry a rate-limited embedding call before giving up on the provider.
 *
 * A free-tier key is a few requests a minute, and treating the first 429 as
 * "this provider does not work" throws away the good embedder for a document
 * that only needed to wait. Anything that is not a rate limit fails
 * immediately, because retrying a bad key just makes the failure slower.
 */
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!/\b429\b|rate limit/i.test(err.message || '')) throw err;
      if (attempt === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1500 + Math.random() * 500));
    }
  }
  throw lastErr;
}

export async function embedQuery(text, opts = {}) {
  const { vectors, provider, dim } = await embedBatch([text], { ...opts, inputType: 'query' });
  return { vector: vectors[0], provider, dim };
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
