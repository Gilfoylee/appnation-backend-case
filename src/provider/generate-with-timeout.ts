import { type AiProvider, ProviderTimeoutError } from './ai-provider.js';

/**
 * Calls the provider with a hard deadline. On expiry the provider's signal is aborted (so a
 * cooperative provider stops waiting) and the call rejects with ProviderTimeoutError even if the
 * provider ignores the signal. The timer is always cleared, so nothing outlives the request.
 */
export async function generateWithTimeout(
  provider: AiProvider,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ProviderTimeoutError(timeoutMs);
      // Reject first so the race settles with the timeout, then tell the provider to stop.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([provider.generate(prompt, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
