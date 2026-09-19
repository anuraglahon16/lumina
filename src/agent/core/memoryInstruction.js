/**
 * What, exactly, to remember when a user says "remember this".
 *
 * The router already recognises the shape of the request and keeps it off the
 * web. What was missing is the rest: nothing was stored, so `GET /memory`
 * returned an empty list and every downstream behaviour — recall in a new
 * thread, delete — had nothing to act on.
 *
 * The extraction matters because the wrong half is easy to keep. Asked to
 * "Remember this preference for all future answers: always answer in British
 * English", the thing worth storing is the preference, not the sentence about
 * storing it. A memory injected into later prompts that reads "remember this
 * preference for all future answers" tells the model to remember something and
 * never says what.
 *
 * Deliberately not a model call. This runs on the first turn of a request whose
 * whole job is to be fast, the grammar is narrow, and a round trip here buys
 * nothing a regular expression cannot do — while adding a way for the save to
 * fail nondeterministically, which is the failure mode being fixed.
 */

/** "Remember that", "please note:", "keep in mind that" — the wrapper, not the content. */
const IMPERATIVE_PREFIX =
  /^\s*(?:please\s+)?(?:remember|memorise|memorize|note|keep in mind|make a note)\b(?:\s+(?:that|this)\b)?[\s:,-]*/i;

/**
 * A lead-in that ends in a colon, like "Remember this preference for all future
 * answers:". Bounded so a colon deep inside the content is not mistaken for the
 * end of a preamble — "remember: ratios above 3:1 are suspect" keeps its ratio.
 */
const PREAMBLE_TO_COLON = /^[^:]{0,80}:\s*/;

/** Standing instructions carry their meaning in the whole sentence. */
const STANDING = /^\s*(?:from now on|going forward|in future|always|never)\b/i;

/**
 * The content of a memory instruction, or null when there is nothing in it.
 *
 * Null is a real answer and the caller must treat it as one: "Remember this:"
 * is a request to store nothing, and storing the empty string or the word
 * "Remember" would both be worse than refusing.
 */
export function memoryContentFrom(instruction) {
  const text = String(instruction ?? '').trim();
  if (!text) return null;

  // A standing instruction is kept whole: "Always answer in metric units" means
  // what it says, and stripping "always" inverts nothing but loses the force.
  if (STANDING.test(text)) return tidy(text);

  // "Remember this preference for all future answers: <content>" — everything
  // after the colon is the content, provided anything follows it.
  if (IMPERATIVE_PREFIX.test(text)) {
    const afterColon = text.replace(PREAMBLE_TO_COLON, '');
    if (afterColon !== text && afterColon.trim()) return tidy(afterColon);
    const stripped = text.replace(IMPERATIVE_PREFIX, '');
    return stripped.trim() ? tidy(stripped) : null;
  }

  return tidy(text);
}

/** Enough words to be a preference rather than a fragment of one. */
function tidy(text) {
  const out = text.replace(/\s+/g, ' ').trim().replace(/^[,:;-]\s*/, '');
  if (out.length < 3) return null;
  // A single word is never a preference worth carrying into future prompts.
  if (!/\s/.test(out) && out.length < 12) return null;
  return out;
}
