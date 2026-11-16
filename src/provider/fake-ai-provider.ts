import { normalizePrompt } from '../domain/prompt.js';
import { sleep } from '../lib/sleep.js';
import { type AiProvider, ProviderError } from './ai-provider.js';

export interface FakeAiProviderDelays {
  normalMs: number;
  slowMs: number;
  errorMs: number;
  /** How long a "timeout" prompt stays silent before answering. */
  hangMs: number;
}

const DEFAULT_DELAYS: FakeAiProviderDelays = {
  normalMs: 300,
  slowMs: 2_000,
  errorMs: 300,
  hangMs: 30_000,
};

/**
 * Stand-in for a real LLM:
 * - "slow..."    answers after ~2 s
 * - "error..."   fails after a short wait
 * - "timeout..." stays silent for 30 s (the service gives up after 3 s)
 * - anything else answers "Sonuç: <normalized prompt>" after ~300 ms
 *
 * All waits are timer based (never block the event loop) and stop as soon as `signal` aborts.
 */
export class FakeAiProvider implements AiProvider {
  private readonly delays: FakeAiProviderDelays;

  constructor(delays: Partial<FakeAiProviderDelays> = {}) {
    this.delays = { ...DEFAULT_DELAYS, ...delays };
  }

  async generate(prompt: string, signal?: AbortSignal): Promise<string> {
    const normalized = normalizePrompt(prompt);

    if (normalized.startsWith('timeout')) {
      await sleep(this.delays.hangMs, signal);
    } else if (normalized.startsWith('error')) {
      await sleep(this.delays.errorMs, signal);
      throw new ProviderError('Fake provider failure');
    } else if (normalized.startsWith('slow')) {
      await sleep(this.delays.slowMs, signal);
    } else {
      await sleep(this.delays.normalMs, signal);
    }

    // The exact output format is mandated by the case specification.
    return `Sonuç: ${normalized}`;
  }
}
