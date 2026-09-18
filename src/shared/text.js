/**
 * Cutting text without cutting a character in half.
 *
 * `String.prototype.slice` counts UTF-16 code units, and every emoji, rare CJK
 * character and mathematical symbol is a surrogate *pair* of them. Slicing
 * between the two halves leaves a lone surrogate: a string that is valid in
 * JavaScript, serialises to `"\ud83d"`, and is rejected by the Anthropic API
 * with `"The request body is not valid JSON: no low surrogate in string"`.
 *
 * That is not a rare edge. Page text is truncated in several places — the
 * fetcher's character ceiling, the four-hundred character source snippet, the
 * per-source cap in the synthesis prompt — and the web is full of emoji. A
 * single one landing on a boundary fails the whole request, so the answer is
 * lost to a formatting detail of text nobody chose.
 *
 * Two functions rather than one, because the two cases are different. `safeSlice`
 * is for when we are the ones cutting and can simply not cut there.
 * `stripLoneSurrogates` is for text that arrived already damaged, where the only
 * options are to drop the orphan or to fail.
 */

/** A high surrogate with no low after it, or a low with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove orphaned halves of surrogate pairs, leaving complete characters alone. */
export function stripLoneSurrogates(text) {
  const s = String(text ?? '');
  return LONE_SURROGATE.test(s) ? s.replace(LONE_SURROGATE, '') : s;
}

/**
 * Slice to at most `max` code units, never splitting a surrogate pair.
 *
 * Takes one character less rather than one more: a snippet that is 399 units
 * long is a snippet, and a snippet with half a character on the end is a
 * rejected request.
 */
export function safeSlice(text, max, start = 0) {
  const s = String(text ?? '');
  if (max === undefined || start + max >= s.length) return stripLoneSurrogates(s.slice(start));
  const cut = s.slice(start, start + max);
  // If the last unit is a high surrogate its partner is on the other side of
  // the cut, so drop it.
  const last = cut.charCodeAt(cut.length - 1);
  const trimmed = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return stripLoneSurrogates(trimmed);
}
