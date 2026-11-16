import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/lib/cursor.js';

describe('history cursor', () => {
  it('round-trips createdAt with millisecond precision and the id', () => {
    const position = { createdAt: new Date('2026-11-16T10:20:30.456Z'), id: randomUUID() };

    const cursor = encodeCursor(position);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(position);
  });

  it.each([
    ['not base64 json', 'definitely-not-a-cursor'],
    ['json without fields', Buffer.from('{}').toString('base64url')],
    ['bad timestamp', Buffer.from(JSON.stringify({ t: 'yesterday', id: randomUUID() })).toString('base64url')],
    ['bad id', Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000Z', id: '1' })).toString('base64url')],
  ])('rejects %s', (_label, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});
