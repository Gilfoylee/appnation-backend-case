export interface AiProvider {
  /**
   * Generates text for an already-normalized prompt.
   * Implementations should stop work and reject when `signal` is aborted.
   */
  generate(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** The provider answered with an error. */
export class ProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

/** The provider did not answer within the allowed time. */
export class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Provider did not respond within ${timeoutMs} ms`);
    this.name = 'ProviderTimeoutError';
  }
}
