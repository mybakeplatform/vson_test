export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Not permitted for this tenant') =>
  new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) =>
  new HttpError(409, 'CONFLICT', msg, details);
export const unprocessable = (code: string, msg: string, details?: unknown) =>
  new HttpError(422, code, msg, details);
