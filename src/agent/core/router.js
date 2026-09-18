/**
 * What kind of question this is, decided without asking a model.
 *
 * Quick mode's problem was never the research, it was the deliberation in front
 * of it: three model turns to discover that a question about the open web needs
 * a web search. That decision is knowable from the request, and a turn spent
 * reaching it is a turn spent before the reader sees anything.
 *
 * Four kinds, and the rules that separate them are deliberately conservative.
 * Misrouting is not free — a follow-up sent down the standalone path is
 * researched without the context that makes it answerable — so anything
 * ambiguous goes to the path that does the most work rather than the least.
 */

export const QUESTION_KIND = {
  DOCUMENTS: 'documents',
  STANDALONE_WEB: 'standalone_web',
  CONTEXTUAL_FOLLOW_UP: 'contextual_follow_up',
  MEMORY_INSTRUCTION: 'memory_instruction',
};

/**
 * An instruction about what to remember, rather than a question to research.
 *
 * Anchored at the start and requiring the imperative, because "remember" in the
 * middle of a sentence is usually part of a real question — "do people remember
 * where they were" is not an instruction to store anything.
 */
const MEMORY_INSTRUCTION = [
  /^\s*(?:please\s+)?(?:remember|memorise|memorize|note|keep in mind|make a note)\b(?:\s+(?:that|this|i|my|we|our)\b|\s*[:,])/i,
  /^\s*(?:please\s+)?(?:forget|delete|remove|erase)\b.{0,40}\b(?:that|this|memory|memories|what i (?:said|told))\b/i,
  /^\s*(?:don'?t|do not) forget\b/i,
  // A standing instruction about how to behave from here on. The opener alone
  // carries it: a question anyone wants researched rarely begins this way.
  /^\s*(?:from now on|going forward|in future|always|never)\b/i,
];

/** Openers that only make sense against something already said. */
const REFERENTIAL_OPENER =
  /^\s*(?:and|but|so|also|then|what about|how about|why|why not|what if|which one|who|when|where|ok(?:ay)?[,\s]|yes[,\s]|no[,\s])\b/i;

/** A pronoun or demonstrative standing in for something earlier. */
const DANGLING_REFERENCE =
  /\b(?:it|its|it's|they|them|their|that|those|these|this|he|him|his|she|her|the former|the latter|the same|the above|the one)\b/i;

/** Phrases that explicitly point back at the conversation. */
const EXPLICIT_BACKREFERENCE = /\b(?:you (?:said|mentioned|wrote)|as (?:above|mentioned)|earlier|previously|before that|the last one|that answer)\b/i;

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * A question that names its own subject can be researched on its own.
 *
 * Crude on purpose: a capitalised word that is not the first, a digit, a
 * hyphenated or dotted technical token, or a quoted phrase. Any of them means
 * the question carries something concrete to search for, which is the thing a
 * rewrite would otherwise have to supply.
 */
function namesItsOwnSubject(query) {
  const all = words(query);
  // The first word is skipped only when it is the sort of word that gets
  // capitalised for being first. A question opening with a real name — which
  // is most short standalone questions — still names its subject.
  const rest = all.slice(1).join(' ');
  const firstIsName = all.length > 0 && /^[A-Z][a-zA-Z]{2,}/.test(all[0]) && !OPENER_WORD.test(all[0]);
  return (
    firstIsName ||
    /[A-Z][a-zA-Z]{2,}/.test(rest) ||
    /\d/.test(query) ||
    /[a-z]+[-.][a-z]+/i.test(query) ||
    /["'][^"']{4,}["']/.test(query)
  );
}

/** Words that begin a sentence without naming anything. */
const OPENER_WORD =
  /^(?:what|why|how|when|where|who|which|is|are|was|were|do|does|did|can|could|should|would|will|and|but|so|also|then|ok|okay|yes|no|the|a|an|tell|give|explain|compare|list|show|any|more|about)$/i;

/**
 * Classify a request.
 *
 * `mode` and `spaceId` are the caller's explicit choice and outrank every
 * heuristic here: someone who asked for their documents gets their documents.
 */
export function classifyQuestion({ query, mode = 'auto', spaceId = null, hasDocuments = false, threadTurns = 0 } = {}) {
  const text = String(query ?? '').trim();
  const reason = (kind, why) => ({ kind, reason: why });

  if (MEMORY_INSTRUCTION.some((re) => re.test(text))) {
    return reason(QUESTION_KIND.MEMORY_INSTRUCTION, 'the request is an instruction about what to remember');
  }

  if (mode === 'docs' || (spaceId && mode !== 'web')) {
    return reason(QUESTION_KIND.DOCUMENTS, spaceId ? 'a Space was named' : 'documents were asked for');
  }

  if (mode === 'auto' && hasDocuments && spaceId) {
    return reason(QUESTION_KIND.DOCUMENTS, 'the Space holds documents');
  }

  // Everything below needs a conversation to refer back to. With none, there is
  // nothing a rewrite could add.
  if (threadTurns > 0) {
    if (EXPLICIT_BACKREFERENCE.test(text)) {
      return reason(QUESTION_KIND.CONTEXTUAL_FOLLOW_UP, 'it refers to the conversation directly');
    }
    // Shortness alone is not a continuation. "PostgreSQL 18 release date?" is
    // four words and needs nothing from the conversation, while "why?" is one
    // word and needs all of it. What separates them is whether the question
    // names what it is about, so that test comes first — the earlier ordering
    // sent every short question down the slow path and contradicted the rule
    // stated two lines below it.
    const n = words(text).length;
    if (n <= 4 && !namesItsOwnSubject(text)) {
      return reason(QUESTION_KIND.CONTEXTUAL_FOLLOW_UP, 'too short to stand on its own, and it names no subject');
    }
    if (REFERENTIAL_OPENER.test(text) && !namesItsOwnSubject(text)) {
      return reason(QUESTION_KIND.CONTEXTUAL_FOLLOW_UP, 'it opens as a continuation and names no subject of its own');
    }
    if (DANGLING_REFERENCE.test(text) && !namesItsOwnSubject(text)) {
      return reason(QUESTION_KIND.CONTEXTUAL_FOLLOW_UP, 'it leans on a pronoun with no subject of its own');
    }
  }

  return reason(QUESTION_KIND.STANDALONE_WEB, 'it stands on its own');
}
