import { __testing as contractMap } from '../../gateway/contract/events.js';

/**
 * A ledger source in the shape the contract declares.
 *
 * One mapping, used in two places that had drifted apart. The thread transcript
 * stored sources in the ledger's own shape - `type: 'web'`, `locator: null`,
 * `doc_id` - and the route converted them on the way out, so what was persisted
 * never matched `MessageDoc.sources` (contract `Source`: `kind`, no null
 * locator, `docId`). Validating the migrated collection is what surfaced it:
 * 0 of 82 messages conformed.
 *
 * Mapping at write time rather than read time also makes the transcript a record
 * of what the user was actually shown, since this is the same shape the
 * `sources` event carries.
 */
export function toContractSource(s) {
  const kind = s.type === 'document' || s.type === 'doc' ? 'doc' : 'web';
  const locator = contractMap.toLocator(s.locator);
  return {
    n: s.n,
    kind,
    title: s.title || s.url || `Source ${s.n}`,
    snippet: (s.snippet || '').trim() || (s.title || 'No excerpt available.'),
    ...(kind === 'web' ? { url: s.url } : { docId: s.doc_id || s.docId }),
    // Omitted rather than null: `Locator` is an object, and a web source has none.
    ...(locator ? { locator } : {}),
    ...(Number.isInteger(s.subQuestion) && s.subQuestion > 0 ? { subQuestion: s.subQuestion } : {}),
  };
}

/** Already contract-shaped? Then pass it through; otherwise map it. */
export function asContractSource(s) {
  return s && typeof s.kind === 'string' && s.type === undefined ? s : toContractSource(s);
}
