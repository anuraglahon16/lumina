/**
 * Post-generation style normalisation.
 *
 * The synthesis prompt asks the model not to write dashes. Asking is
 * probabilistic: it holds on most runs and slips on some. The same reasoning
 * that makes citation validity a harness property rather than a prompt request
 * applies here, so the answer is normalised after generation and the existing
 * authoritative `answer` event carries the corrected text to the client.
 *
 * What this deliberately does NOT touch:
 *
 * - Anything inside quotation marks. The product's whole claim is that it
 *   reports what sources actually said, and silently repunctuating a quotation
 *   falsifies it. A dash inside quotes survives.
 * - Code spans and fenced blocks, where a dash can be syntax.
 * - URLs, where a dash is part of the address.
 * - Hyphens in compound words. Only em and en dashes are in scope.
 *
 * Word choice is not normalised either. Substituting synonyms would change
 * meaning and could corrupt a quoted finding, so the prompt handles vocabulary
 * and punctuation is the only part safe to enforce mechanically.
 */

const EM_OR_EN = /[—–]/;
const EM_OR_EN_G = /[—–]/g;

/** Sentinels from the private use area, which cannot occur in model output. */
const OPEN = '';
const CLOSE = '';

/** Spans whose contents must survive untouched. */
const PROTECTED = [
  /```[\s\S]*?```/g, // fenced code
  /`[^`\n]*`/g, // inline code
  /https?:\/\/\S+/g, // URLs
  /"[^"\n]*"/g, // quoted material, including quotations from sources
  /“[^”\n]*”/g, // smart quotes, which models emit often
];

/**
 * A dash between two numbers is a range ("8:00 a.m.-1:00 p.m.", "2020-2024").
 * A comma there would change the meaning, so ranges become the word "to".
 */
function rewriteRanges(text) {
  return text
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, '$1 to ')
    .replace(/(a\.m\.|p\.m\.|AM|PM|am|pm)\s*[—–]\s*(?=\d)/g, '$1 to ');
}

/**
 * Everything else becomes a comma. A spaced em dash nearly always stands in for
 * an appositive or a parenthetical break, and a comma is grammatical in both
 * positions, which a full stop is not: it would strand a fragment.
 */
function rewriteDashes(text) {
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,+/g, ',') // a paired dash construction can collapse into two
    .replace(/\s+,/g, ',')
    .replace(/,\s*([.!?;:])/g, '$1') // a dash before terminal punctuation leaves a stray comma
    .replace(/([([])\s*,\s*/g, '$1')
    .replace(/,[ \t]*$/gm, '');
}

/**
 * @param {string} text answer markdown as generated
 * @returns {{ text: string, changed: boolean, replaced: number }}
 */
export function normalizeAnswerStyle(text) {
  if (typeof text !== 'string') return { text: '', changed: false, replaced: 0 };
  if (!EM_OR_EN.test(text)) return { text, changed: false, replaced: 0 };

  // Lift protected spans out, rewrite what remains, then put them back. The
  // sentinels cannot collide with ordinary prose the way a bare number would:
  // "page 7" must never be mistaken for a placeholder slot.
  const vault = [];
  let working = text;
  for (const pattern of PROTECTED) {
    working = working.replace(pattern, (match) => {
      vault.push(match);
      return OPEN + (vault.length - 1) + CLOSE;
    });
  }

  const before = (working.match(EM_OR_EN_G) || []).length;
  working = rewriteDashes(rewriteRanges(working));
  const after = (working.match(EM_OR_EN_G) || []).length;

  working = working.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i) => vault[Number(i)]);

  return { text: working, changed: working !== text, replaced: before - after };
}
