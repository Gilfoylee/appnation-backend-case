export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** UTC calendar day key, e.g. '2026-11-16'. Quota buckets are keyed by this value. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function nextUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}
