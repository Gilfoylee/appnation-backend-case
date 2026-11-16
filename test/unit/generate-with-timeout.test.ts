import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AiProvider, ProviderError, ProviderTimeoutError } from '../../src/provider/ai-provider.js';
import { generateWithTimeout } from '../../src/provider/generate-with-timeout.js';

describe('generateWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the provider result and leaves no timer behind', async () => {
    const provider: AiProvider = { generate: async (prompt) => `ok ${prompt}` };

    await expect(generateWithTimeout(provider, 'x', 3_000)).resolves.toBe('ok x');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates provider errors unchanged', async () => {
    const provider: AiProvider = {
      generate: async () => {
        throw new ProviderError('boom');
      },
    };

    await expect(generateWithTimeout(provider, 'x', 3_000)).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects with ProviderTimeoutError at the deadline and aborts the provider signal', async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider: AiProvider = {
      generate: (_prompt, signal) => {
        receivedSignal = signal;
        return new Promise(() => {}); // never answers
      },
    };

    const result = generateWithTimeout(provider, 'x', 3_000);
    const assertion = expect(result).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBeInstanceOf(ProviderTimeoutError);
  });

  it('times out even when the provider ignores the abort signal', async () => {
    const provider: AiProvider = {
      generate: () => new Promise((resolve) => setTimeout(() => resolve('too late'), 30_000)),
    };

    const result = generateWithTimeout(provider, 'x', 3_000);
    const assertion = expect(result).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });
});
