import { describe, expect, it } from 'vitest';
import { cacheKey } from '../../src/cache/generation-cache.js';
import { normalizePrompt } from '../../src/domain/prompt.js';

describe('cacheKey', () => {
  it('is a short, fixed-size, versioned key', () => {
    expect(cacheKey('merhaba')).toMatch(/^generation:v1:[0-9a-f]{64}$/);
    expect(cacheKey('x'.repeat(2000))).toHaveLength(cacheKey('x').length);
  });

  it('maps differently written versions of a prompt to the same key once normalized', () => {
    expect(cacheKey(normalizePrompt('merhaba'))).toBe(cacheKey(normalizePrompt('  MERHABA ')));
    expect(cacheKey(normalizePrompt('merhaba'))).not.toBe(cacheKey(normalizePrompt('hello')));
  });
});
