/**
 * What a Deep Search plan has to be before the run is allowed to act on it.
 *
 * The decomposition is the feature. A deep run that researches one question is
 * a quick run that cost seven times as much, and the benchmark says so directly
 * by scoring the *minimum* number of sub-questions across runs: one bad plan in
 * four drags the whole measurement to that plan's size. The old fallback
 * returned the user's question back as a single sub-question, which is how a
 * run reported zero.
 *
 * So the plan is validated rather than trusted, and there are exactly three
 * ways a run can end up with one:
 *
 *   model     the planner returned something valid
 *   repair    it did not, and a second attempt with the problems named did
 *   fallback  neither worked, and the harness decomposed the question itself
 *
 * Which of the three happened is recorded on the plan and in the run log. A
 * fallback is a degraded run that still answers; reporting it as a model plan
 * would hide the one thing worth knowing about it.
 */

export const PLAN_ORIGIN = { MODEL: 'model', REPAIR: 'repair', FALLBACK: 'fallback' };

const MAX_QUESTION_CHARS = 240;
const MAX_REASON_CHARS = 200;

/** Loose enough to catch rephrasings, strict enough not to merge real distinctions. */
const fingerprint = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort()
    .join(' ');

const STOP = new Set('the a an and or of in on at to for with from by as is are was were be been what which how why when does do did'.split(' '));

/**
 * Check a planner's output against the shape a run can actually execute.
 *
 * Returns the problems rather than throwing, because the first thing done with
 * them is to hand them back to the planner as a repair instruction, and a
 * message that names what was wrong repairs far more reliably than "try again".
 */
export function validatePlan(raw, { query, min = 3, max = 5 } = {}) {
  const problems = [];
  const list = Array.isArray(raw?.sub_questions) ? raw.sub_questions : null;

  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['the planner returned nothing parseable as JSON'] };
  if (!list) return { ok: false, problems: ['`sub_questions` is missing or is not an array'] };

  const seen = new Map();
  const cleaned = [];

  for (const entry of list) {
    // `q` is what the compact planner emits; `question` is accepted too, so a
    // planner that answers in the fuller shape is not thrown away.
    const question = String(entry?.q ?? entry?.question ?? entry ?? '').trim();
    if (!question) {
      problems.push('a sub-question was empty');
      continue;
    }
    const key = fingerprint(question);
    if (!key) {
      problems.push(`a sub-question carried no content words: ${JSON.stringify(question.slice(0, 60))}`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`two sub-questions ask the same thing: ${JSON.stringify(question.slice(0, 60))}`);
      continue;
    }
    // A sub-question that restates the whole question researches the whole
    // question, which is the decomposition failing while looking like a plan.
    if (query && key === fingerprint(query)) {
      problems.push('a sub-question just restates the original question');
      continue;
    }
    seen.set(key, true);
    cleaned.push({
      id: `q${cleaned.length + 1}`,
      question: question.slice(0, MAX_QUESTION_CHARS),
      why: entry?.why || entry?.reason ? String(entry.why || entry.reason).trim().slice(0, MAX_REASON_CHARS) : null,
      search_queries: Array.isArray(entry?.search_queries) ? entry.search_queries.filter(Boolean).slice(0, 4).map(String) : [],
    });
    if (cleaned.length === max) break;
  }

  if (cleaned.length < min) {
    problems.push(`a plan needs at least ${min} distinct sub-questions; ${cleaned.length} survived validation`);
    return { ok: false, problems, sub_questions: cleaned };
  }

  return {
    ok: true,
    problems,
    plan: {
      interpretation: String(raw.interpretation || query || '').slice(0, 600) || null,
      answer_shape: raw.answer_shape ? String(raw.answer_shape).slice(0, 400) : null,
      sub_questions: cleaned,
    },
  };
}

/**
 * Decompose a question without a model.
 *
 * Used only when the planner has already failed twice, and deliberately
 * generic: it asks what is known, what supports it, and what argues against it.
 * That is a real decomposition of almost any researchable question and it
 * cannot be tuned to a particular one, which matters — a fallback that encoded
 * anything about the questions being graded would be answering the benchmark
 * rather than answering the user.
 *
 * It is not as good as a real plan. It exists so that a failed planner costs
 * quality rather than costing the run.
 */
export function fallbackPlan(query, { min = 3, max = 5 } = {}) {
  const subject = String(query ?? '').trim().replace(/\s+/g, ' ').slice(0, 160) || 'the question';
  const angles = [
    { question: `What is directly established about ${subject}?`, why: 'the primary evidence the answer has to rest on' },
    { question: `What specific findings, figures or examples support ${subject}?`, why: 'concrete evidence rather than general claims' },
    { question: `What limitations, disagreements or contrary findings apply to ${subject}?`, why: 'a one-sided answer to a researchable question is an incomplete one' },
    { question: `What has changed recently regarding ${subject}?`, why: 'evidence that may have been superseded' },
    { question: `In what context or by whom is ${subject} discussed?`, why: 'who is making the claims and on what basis' },
  ];

  return {
    interpretation: subject,
    answer_shape: 'A direct answer, the evidence for it, and what that evidence does not settle.',
    sub_questions: angles.slice(0, Math.min(Math.max(min, 3), max)).map((a, i) => ({
      id: `q${i + 1}`,
      question: a.question,
      why: a.why,
      search_queries: [subject],
    })),
  };
}

/** The instruction a repair attempt is given: what was wrong, in the planner's own terms. */
export function repairInstruction(problems, { min = 3, max = 5 } = {}) {
  return [
    'That plan cannot be executed. Problems found:',
    ...problems.slice(0, 6).map((p) => `- ${p}`),
    '',
    `Return JSON only: {"interpretation": string, "answer_shape": string, "sub_questions": [{"question": string, "why": string, "search_queries": [string]}]}`,
    `Between ${min} and ${max} sub-questions. Each must ask something different, and none may restate the original question.`,
  ].join('\n');
}
