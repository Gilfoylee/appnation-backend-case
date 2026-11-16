import { z } from 'zod';
import type { HistoryPosition } from '../db/generations.repository.js';

// The cursor is opaque to clients: base64url(JSON) of the last returned row's (createdAt, id).
const payloadSchema = z.object({
  t: z.iso.datetime(),
  id: z.uuid(),
});

export function encodeCursor(position: HistoryPosition): string {
  const payload = { t: position.createdAt.toISOString(), id: position.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Returns `null` for anything that is not a cursor produced by `encodeCursor`. */
export function decodeCursor(cursor: string): HistoryPosition | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  return { createdAt: new Date(parsed.data.t), id: parsed.data.id };
}
