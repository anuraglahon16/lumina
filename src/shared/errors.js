export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'invalid_request', msg, details);
export const notFound = (msg) => new HttpError(404, 'not_found', msg);
export const tooManyRequests = (msg, details) => new HttpError(429, 'rate_limited', msg, details);
export const upstreamError = (msg, details) => new HttpError(502, 'upstream_error', msg, details);

/** Terminal Express error handler. Shapes every failure the same way. */
export function errorHandler(logger) {
  return (err, req, res, _next) => {
    const status = err.status || 500;
    const body = {
      error: {
        code: err.code || 'internal_error',
        message: status >= 500 ? 'Internal error' : err.message,
        ...(err.details ? { details: err.details } : {}),
        request_id: req.requestId,
      },
    };
    logger.error('request_failed', {
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      status,
      code: body.error.code,
      err: err.message,
      stack: status >= 500 ? err.stack : undefined,
    });
    if (res.headersSent) return res.end();
    res.status(status).json(body);
  };
}
