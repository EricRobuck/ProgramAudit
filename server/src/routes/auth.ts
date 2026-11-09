import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db.js';
import { newCsrfToken, requireUser, USER_COLUMNS } from '../lib/auth.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { isValidTimezone, parse, passwordSchema, trimmed } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';

export const authRouter = Router();

// Simple in-memory throttle for failed sign-ins (per client address + email).
const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function throttleKey(ip: string | undefined, email: string) {
  return `${ip ?? '?'}|${email.toLowerCase()}`;
}

// A fixed hash so that unknown emails take the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-placeholder', 10);

export function publicUser(u: Record<string, unknown>) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isFaculty: u.is_faculty,
    active: u.active,
    timezone: u.timezone,
  };
}

authRouter.post('/login', async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }), req.body);
  const key = throttleKey(req.ip, body.email);
  const f = failures.get(key);
  if (f && Date.now() - f.first < WINDOW_MS && f.count >= MAX_FAILURES) {
    throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again later.');
  }
  const user = await db()('users').whereRaw('lower(email) = lower(?)', [body.email]).first();
  const ok = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) {
    const cur = f && Date.now() - f.first < WINDOW_MS ? f : { count: 0, first: Date.now() };
    cur.count += 1;
    failures.set(key, cur);
    throw unauthorized('Email or password is incorrect');
  }
  failures.delete(key);
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.csrfToken = newCsrfToken();
  await logActivity(db(), { actorId: user.id, action: 'login' });
  res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
});

authRouter.post('/logout', async (req, res) => {
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie('pa.sid');
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  if (!req.session.csrfToken) req.session.csrfToken = newCsrfToken();
  res.json({ user: publicUser(req.user as unknown as Record<string, unknown>), csrfToken: req.session.csrfToken });
});

authRouter.patch('/me', async (req, res) => {
  const user = requireUser(req);
  const body = parse(
    z.object({
      displayName: trimmed(1, 120).optional(),
      timezone: z.string().max(64).optional(),
      currentPassword: z.string().max(200).optional(),
      newPassword: passwordSchema.optional(),
    }),
    req.body,
  );
  const patch: Record<string, unknown> = {};
  if (body.displayName) patch.display_name = body.displayName;
  if (body.timezone) {
    if (!isValidTimezone(body.timezone)) throw badRequest('Unknown timezone');
    patch.timezone = body.timezone;
  }
  if (body.newPassword) {
    const row = await db()('users').where({ id: user.id }).first();
    if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, row.password_hash))) {
      throw badRequest('Current password is incorrect');
    }
    patch.password_hash = await bcrypt.hash(body.newPassword, 12);
  }
  if (Object.keys(patch).length) {
    await db()('users').where({ id: user.id }).update({ ...patch, updated_at: db().fn.now() });
  }
  const fresh = await db()('users').select(USER_COLUMNS).where({ id: user.id }).first();
  res.json({ user: publicUser(fresh) });
});
