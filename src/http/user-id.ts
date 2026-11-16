import type { FastifyRequest } from 'fastify';
import { invalidUserId, unauthorized } from '../domain/errors.js';

const MAX_USER_ID_LENGTH = 128;

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/**
 * onRequest hook: runs before the body is read, so unidentified requests get 401
 * without the server parsing their payload.
 */
export async function requireUserId(request: FastifyRequest): Promise<void> {
  const header = request.headers['x-user-id'];
  const userId = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
  if (userId === '') {
    throw unauthorized();
  }
  if (userId.length > MAX_USER_ID_LENGTH) {
    throw invalidUserId();
  }
  request.userId = userId;
}
