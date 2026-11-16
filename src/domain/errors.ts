/** An error that maps directly to an HTTP response of the shape `{ "error": code }`. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (): AppError => new AppError(401, 'unauthorized', 'X-User-Id header is required');
export const invalidUserId = (): AppError => new AppError(400, 'invalid_user_id', 'X-User-Id is too long');
export const invalidPrompt = (): AppError =>
  new AppError(400, 'invalid_prompt', 'prompt must be a string of 1-2000 characters after trimming');
export const invalidLimit = (): AppError => new AppError(400, 'invalid_limit', 'limit must be a positive integer');
export const invalidCursor = (): AppError => new AppError(400, 'invalid_cursor', 'cursor is malformed');
export const quotaExceeded = (): AppError => new AppError(429, 'quota_exceeded', 'Daily generation quota exceeded');
export const providerFailed = (): AppError => new AppError(502, 'provider_error', 'AI provider failed');
export const providerTimedOut = (): AppError => new AppError(504, 'provider_timeout', 'AI provider timed out');
