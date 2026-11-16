import { describe, expect, it } from 'vitest';
import { nextUtcMidnight, utcDay } from '../../src/lib/clock.js';

describe('UTC day helpers', () => {
  it('uses the UTC calendar day regardless of offsets', () => {
    expect(utcDay(new Date('2026-11-16T23:59:59.999Z'))).toBe('2026-11-16');
    expect(utcDay(new Date('2026-11-17T01:30:00+03:00'))).toBe('2026-11-16');
  });

  it('computes the next UTC midnight, including month and year boundaries', () => {
    expect(nextUtcMidnight(new Date('2026-11-16T12:00:00Z')).toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
