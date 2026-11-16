import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/provider/ai-provider.js';
import { FakeAiProvider } from '../../src/provider/fake-ai-provider.js';

/** Resolves to the settled state of a promise without awaiting it forever. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

describe('FakeAiProvider (fake timers, no real waiting)', () => {
  const provider = new FakeAiProvider();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers "Sonuç: <normalized prompt>" after ~300 ms', async () => {
    const call = track(provider.generate('  Merhaba   DÜNYA '));

    await vi.advanceTimersByTimeAsync(299);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.value).toBe('Sonuç: merhaba dünya');
  });

  it('takes ~2 s for prompts starting with "slow"', async () => {
    const call = track(provider.generate('slow request'));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.value).toBe('Sonuç: slow request');
  });

  it('throws after waiting for prompts starting with "error"', async () => {
    const call = track(provider.generate('error deneme'));

    await vi.advanceTimersByTimeAsync(299);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.error).toBeInstanceOf(ProviderError);
  });

  it('stays silent for 30 s for prompts starting with "timeout"', async () => {
    const call = track(provider.generate('timeout deneme'));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
  });

  it('stops waiting and clears its timer as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const call = track(provider.generate('timeout deneme', controller.signal));

    await vi.advanceTimersByTimeAsync(100);
    const reason = new Error('stop');
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});
