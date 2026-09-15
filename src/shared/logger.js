import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

const SECRET_KEYS = /(api[-_]?key|authorization|token|secret|password|x-api-key)/i;

/** Never let a key reach a log line, even if someone passes the whole config. */
function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, service, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, service, msg, ...redact(fields || {}) };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export function createLogger(service, base = {}) {
  const bound = (level) => (msg, fields) => emit(level, service, msg, { ...base, ...fields });
  return {
    debug: bound('debug'),
    info: bound('info'),
    warn: bound('warn'),
    error: bound('error'),
    /** Derive a child logger that carries request/run context on every line. */
    child(extra) {
      return createLogger(service, { ...base, ...extra });
    },
  };
}
