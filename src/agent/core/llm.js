import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { HttpError } from '../../shared/errors.js';
import { breaker } from '../../shared/circuitBreaker.js';

const log = createLogger('llm');

let client = null;

/** The API key lives only in the environment; it is never persisted or logged. */
export function anthropic() {
  if (!config.llm.apiKey) {
    throw new HttpError(503, 'llm_unavailable', 'ANTHROPIC_API_KEY is not set. Add it to your environment and restart.');
  }
  if (!client) {
    client = new Anthropic({
      apiKey: config.llm.apiKey,
      maxRetries: config.llm.maxRetries,
      timeout: config.llm.timeoutMs,
    });
  }
  return client;
}

/**
 * Request-shape differences between model families.
 *
 * Sending a parameter a model does not accept is a 400, not a warning. Adaptive
 * thinking and `output_config.effort` are supported on the Opus and Sonnet
 * families but not on Haiku 4.5, so a routed call that lands on the cheap model
 * fails outright unless the request is shaped for it. The mechanical sub-tasks
 * routed to Haiku do not need reasoning, so the entry simply omits both.
 */
const MODEL_PROFILES = {
  'claude-haiku-4-5': { adaptiveThinking: false, effort: false },
};
const DEFAULT_PROFILE = { adaptiveThinking: true, effort: true };

const profileFor = (model) => MODEL_PROFILES[model] || DEFAULT_PROFILE;

/** Exported so the per-model request shape can be asserted without a network call. */
export function baseParams({ model, system, messages, tools, maxTokens, effort, cacheSystem = true }) {
  const resolved = model || config.llm.model;
  const profile = profileFor(resolved);
  const params = {
    model: resolved,
    max_tokens: maxTokens || 8000,
    messages,
  };
  // Adaptive thinking: the model decides how much to reason per turn.
  if (profile.adaptiveThinking) params.thinking = { type: 'adaptive' };
  if (profile.effort) params.output_config = { effort: effort || 'medium' };
  if (system) {
    // The system prompt is the stable prefix, so it carries the cache breakpoint.
    params.system = cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : [{ type: 'text', text: system }];
  }
  if (tools?.length) params.tools = tools;
  return params;
}

/**
 * Does this failure say the provider is unhealthy, or that we sent something
 * wrong? A 400 for a malformed request is our bug and must not trip a breaker
 * shared by every caller. An exhausted credit balance arrives as a 400 too, but
 * it is persistent and provider-side, so it should stop the hammering.
 */
function isProviderFault(err) {
  if (err instanceof Anthropic.AuthenticationError) return true;
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIError) {
    if (err.status >= 500) return true;
    if (err.status === 400) return /credit balance|billing|quota/i.test(err.message || '');
    return false;
  }
  return false;
}

/**
 * The provider breaker. The SDK already retries a blip; this stops the retries
 * becoming the problem once the provider is genuinely down, and keeps five
 * parallel Deep Search branches from each waiting out the full timeout.
 */
export const llmBreaker = () =>
  breaker('anthropic', {
    failureThreshold: config.llm.breakerThreshold,
    cooldownMs: config.llm.breakerCooldownMs,
    countsAsFailure: isProviderFault,
  });

function normalizeError(err) {
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'llm_rate_limited', 'The model provider is rate limiting this key. Retry shortly.');
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(401, 'llm_auth_failed', 'ANTHROPIC_API_KEY was rejected by the provider.');
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new HttpError(504, 'llm_timeout', 'The model request timed out.');
  }
  if (err instanceof Anthropic.APIError) {
    return new HttpError(err.status >= 500 ? 502 : 400, 'llm_error', err.message);
  }
  return err;
}

/** Non-streaming call, priced and recorded into the run log. */
export async function complete({ purpose, recorder, ...opts }) {
  const started = performance.now();
  const params = baseParams(opts);
  try {
    const message = await llmBreaker().run(() => anthropic().messages.create(params));
    const durationMs = Math.round(performance.now() - started);
    recorder?.recordLlmCall({ model: params.model, purpose, usage: message.usage, durationMs, stopReason: message.stop_reason });
    return message;
  } catch (err) {
    recorder?.recordError(`llm:${purpose}`, err);
    log.error('llm_call_failed', { purpose, model: params.model, err: err.message });
    throw normalizeError(err);
  }
}

/**
 * Streaming call. `onText` receives visible text deltas; `onThinking` receives
 * summarized reasoning when the caller opted into displaying it.
 */
export async function streamComplete({ purpose, recorder, onText, onThinking, signal, display, ...opts }) {
  const started = performance.now();
  const params = baseParams(opts);
  // Only ask for reasoning display on a model that accepts adaptive thinking;
  // re-adding it unconditionally would reintroduce the 400 baseParams avoids.
  if (display && params.thinking) params.thinking = { type: 'adaptive', display };
  try {
    const message = await llmBreaker().run(async () => {
      const stream = anthropic().messages.stream(params, { signal });
      if (onText) stream.on('text', onText);
      if (onThinking) stream.on('thinking', (delta) => onThinking(delta));
      return stream.finalMessage();
    });
    const durationMs = Math.round(performance.now() - started);
    recorder?.recordLlmCall({ model: params.model, purpose, usage: message.usage, durationMs, stopReason: message.stop_reason });
    return message;
  } catch (err) {
    recorder?.recordError(`llm:${purpose}`, err);
    log.error('llm_stream_failed', { purpose, model: params.model, err: err.message });
    throw normalizeError(err);
  }
}

export function textOf(message) {
  return (message?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolUsesOf(message) {
  return (message?.content || []).filter((b) => b.type === 'tool_use');
}

/**
 * Parse a JSON object out of a model response. Models occasionally wrap JSON in
 * prose or fences; this recovers the first balanced object/array rather than
 * failing the whole run.
 */
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to brace scanning */
    }
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
