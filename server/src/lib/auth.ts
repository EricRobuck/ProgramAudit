import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../db.js';
import { forbidden, HttpError, notFound, unauthorized } from './errors.js';

export type Role = 'admin' | 'coordinator' | 'professor';

export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  role: Role;
  is_faculty: boolean;
  active: boolean;
  timezone: string;
}

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrfToken?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const USER_COLUMNS = ['id', 'email', 'display_name', 'role', 'is_faculty', 'active', 'timezone'] as const;

/** Loads the signed-in user on each request; inactive accounts are signed out. */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const id = req.session?.userId;
  if (id) {
    const user = await db()('users').select(USER_COLUMNS).where({ id }).first();
    if (user && user.active) req.user = user;
    else if (req.session) delete req.session.userId;
  }
  next();
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: Request): AuthUser {
  const user = requireUser(req);
  if (user.role !== 'admin') throw forbidden('Administrator access required');
  return user;
}

export function newCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * CSRF defense: state-changing requests must carry the per-session token in
 * the X-CSRF-Token header (or, before sign-in, the X-Requested-With header,
 * which browsers cannot send cross-origin without a CORS preflight we never
 * grant). Requests with a foreign Origin are rejected outright.
 */
export function csrfProtection(allowedOrigin: string) {
  const allowed = new URL(allowedOrigin).origin;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      const host = req.get('host');
      const sameHost = host && (origin === `https://${host}` || origin === `http://${host}`);
      if (origin !== allowed && !sameHost) return next(forbidden('Cross-origin request rejected'));
    }
    if (req.get('x-requested-with') !== 'ProgramAudit') {
      return next(new HttpError(403, 'csrf', 'Missing request header'));
    }
    if (req.session?.userId) {
      const token = req.get('x-csrf-token');
      const expected = req.session.csrfToken;
      if (
        !token ||
        !expected ||
        token.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      ) {
        return next(new HttpError(403, 'csrf', 'Security token missing or expired. Reload the page.'));
      }
    }
    next();
  };
}

export type ReviewAccessLevel = 'admin' | 'coordinator' | 'faculty';

export interface ReviewRow {
  id: number;
  major_id: number;
  title: string;
  period: string;
  description: string;
  archived_at: Date | null;
}

/** Effective access to a review. Unauthorized callers get 404 so identifiers cannot be probed. */
export async function reviewAccess(
  user: AuthUser,
  reviewId: number,
  q: Knex | Knex.Transaction = db(),
  opts: { forUpdate?: boolean } = {},
): Promise<{ review: ReviewRow; level: ReviewAccessLevel }> {
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw notFound('Review not found');
  const query = q('reviews').where({ id: reviewId }).first();
  if (opts.forUpdate) query.forUpdate();
  const review = await query;
  if (!review) throw notFound('Review not found');
  if (user.role === 'admin') return { review, level: 'admin' };
  const row = await q('review_access').where({ review_id: reviewId, user_id: user.id }).first();
  if (!row) throw notFound('Review not found');
  const level: ReviewAccessLevel =
    row.access === 'coordinator' && user.role === 'coordinator' ? 'coordinator' : 'faculty';
  return { review, level };
}

export const canManage = (level: ReviewAccessLevel) => level === 'admin' || level === 'coordinator';

export async function requireManage(
  user: AuthUser,
  reviewId: number,
  q: Knex | Knex.Transaction = db(),
  opts: { forUpdate?: boolean; allowArchived?: boolean } = {},
) {
  const access = await reviewAccess(user, reviewId, q, opts);
  if (!canManage(access.level)) throw forbidden('Coordinator access to this review is required');
  if (access.review.archived_at && !opts.allowArchived) {
    throw new HttpError(409, 'review_archived', 'This review is archived and read-only. Reopen it first.');
  }
  return access;
}

export function parseId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound();
  return n;
}
