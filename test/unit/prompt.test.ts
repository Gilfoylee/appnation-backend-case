import { describe, expect, it } from 'vitest';
import { normalizePrompt, preparePrompt } from '../../src/domain/prompt.js';

describe('preparePrompt', () => {
  it('trims leading and trailing whitespace', () => {
    expect(preparePrompt('  \n hello world \t ')).toBe('hello world');
  });

  it('keeps inner whitespace and casing untouched', () => {
    expect(preparePrompt(' Hello   World ')).toBe('Hello   World');
  });

  it.each(['', '   ', '\n\t'])('rejects %j as empty', (input) => {
    expect(preparePrompt(input)).toBeNull();
  });

  it('accepts exactly 2000 characters and rejects 2001', () => {
    expect(preparePrompt('a'.repeat(2000))).toHaveLength(2000);
    expect(preparePrompt('a'.repeat(2001))).toBeNull();
  });

  it('counts code points, so astral characters count once', () => {
    expect(preparePrompt('😀'.repeat(2000))).not.toBeNull();
    expect(preparePrompt('😀'.repeat(2001))).toBeNull();
  });

  it('rejects NUL characters, which PostgreSQL text cannot store', () => {
    expect(preparePrompt('a\u0000b')).toBeNull();
  });
});

describe('normalizePrompt', () => {
  it.each([
    ['merhaba', 'merhaba'],
    ['MERHABA', 'merhaba'],
    ['  Hello   ÉCOLE  ', 'hello école'],
    ['tabs\tand\nnewlines', 'tabs and newlines'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizePrompt(input)).toBe(expected);
  });
});
