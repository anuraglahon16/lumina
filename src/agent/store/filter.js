/**
 * The small query language both stores understand.
 *
 * The JSON store filtered with a JavaScript predicate, which is expressive but
 * untranslatable: a function cannot be sent to a database, so every query would
 * have to load the whole collection and filter in the process. Describing the
 * filter as data instead lets MongoDB run it as a real query while the JSON
 * store evaluates the same description in memory.
 *
 * Only the operators the application actually uses are supported. A larger
 * subset would be speculative, and silently ignoring an unsupported operator is
 * how a filter quietly returns the wrong rows.
 */

const OPERATORS = new Set(['$in', '$nin', '$ne', '$exists', '$gte', '$lte', '$gt', '$lt']);

export function matchesFilter(item, filter = {}) {
  for (const [field, condition] of Object.entries(filter)) {
    const value = item?.[field];

    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      for (const [op, operand] of Object.entries(condition)) {
        if (!OPERATORS.has(op)) throw new Error(`unsupported filter operator: ${op}`);
        if (op === '$in' && !operand.includes(value)) return false;
        if (op === '$nin' && operand.includes(value)) return false;
        if (op === '$ne' && value === operand) return false;
        if (op === '$exists' && (value !== undefined) !== operand) return false;
        if (op === '$gte' && !(value >= operand)) return false;
        if (op === '$lte' && !(value <= operand)) return false;
        if (op === '$gt' && !(value > operand)) return false;
        if (op === '$lt' && !(value < operand)) return false;
      }
      continue;
    }

    if (value !== condition) return false;
  }
  return true;
}

/** Drop keys whose value is undefined, so "no filter on this field" is expressible. */
export function compact(filter) {
  return Object.fromEntries(Object.entries(filter || {}).filter(([, v]) => v !== undefined && v !== null));
}
