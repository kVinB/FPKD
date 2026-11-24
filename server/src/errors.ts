export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: FieldIssue[];
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { fields?: FieldIssue[]; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = options?.fields;
    this.details = options?.details;
  }
}

export const badRequest = (code: string, message: string, fields?: FieldIssue[]) =>
  new AppError(400, code, message, { fields });
export const unauthorized = (code = 'unauthenticated', message = 'Sign in to continue.') =>
  new AppError(401, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, { details });
export const unprocessable = (message: string, fields?: FieldIssue[]) =>
  new AppError(422, 'validation_failed', message, { fields });
export const tooManyRequests = (message = 'Too many attempts. Try again later.') =>
  new AppError(429, 'rate_limited', message);
export const serviceUnavailable = (message = 'Storage is temporarily unavailable. Retry shortly.') =>
  new AppError(503, 'storage_unavailable', message);
