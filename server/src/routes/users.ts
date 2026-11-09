import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db.js';
import { parseId, requireAdmin, requireUser, USER_COLUMNS } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, passwordSchema, trimmed } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { publicUser } from './auth.js';

export const usersRouter = Router();

const roleSchema = z.enum(['admin', 'coordinator', 'professor']);

usersRouter.get('/users', async (req, res) => {
  requireAdmin(req);
  const rows = await db()('users').select(USER_COLUMNS).orderBy('display_name');
  res.json({ users: rows.map(publicUser) });
});

/**
 * Faculty roster for assignment dropdowns and access management. Includes
 * inactive accounts (flagged) so historical assignments stay identifiable.
 */
usersRouter.get('/faculty', async (req, res) => {
  const user = requireUser(req);
  if (user.role === 'professor') throw forbidden();
  const rows = await db()('users')
    .select('id', 'display_name', 'active', 'is_faculty', 'role')
    .orderBy('display_name');
  res.json({
    faculty: rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      active: r.active,
      isFaculty: r.is_faculty,
      role: r.role,
      assignable: r.active && r.is_faculty,
    })),
  });
});

usersRouter.post('/users', async (req, res) => {
  const admin = requireAdmin(req);
  const body = parse(
    z.object({
      email: z.email().max(254),
      displayName: trimmed(1, 120),
      role: roleSchema,
      isFaculty: z.boolean().default(true),
      password: passwordSchema,
      timezone: z.string().max(64).default('America/New_York'),
    }),
    req.body,
  );
  const exists = await db()('users').whereRaw('lower(email) = lower(?)', [body.email]).first();
  if (exists) throw conflict('email_taken', 'An account with that email already exists');
  const [row] = await db()('users')
    .insert({
      email: body.email,
      display_name: body.displayName,
      role: body.role,
      is_faculty: body.isFaculty,
      password_hash: await bcrypt.hash(body.password, 12),
      timezone: body.timezone,
    })
    .returning(USER_COLUMNS);
  await logActivity(db(), { actorId: admin.id, action: 'user.create', details: { userId: row.id, role: row.role } });
  res.status(201).json({ user: publicUser(row) });
});

usersRouter.patch('/users/:id', async (req, res) => {
  const admin = requireAdmin(req);
  const id = parseId(req.params.id);
  const body = parse(
    z.object({
      displayName: trimmed(1, 120).optional(),
      role: roleSchema.optional(),
      isFaculty: z.boolean().optional(),
      active: z.boolean().optional(),
      password: passwordSchema.optional(),
    }),
    req.body,
  );
  const result = await db().transaction(async (trx) => {
    // Serialize admin-affecting changes so two concurrent edits cannot remove the last admin.
    await trx.raw('lock table users in share row exclusive mode');
    const target = await trx('users').where({ id }).first();
    if (!target) throw notFound('User not found');
    const willBeAdmin = (body.role ?? target.role) === 'admin' && (body.active ?? target.active);
    if (target.role === 'admin' && target.active && !willBeAdmin) {
      const { count } = await trx('users').where({ role: 'admin', active: true }).whereNot({ id }).count({ count: '*' }).first() as { count: string };
      if (Number(count) === 0) throw conflict('last_admin', 'The last active administrator cannot be removed or deactivated');
    }
    const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
    if (body.displayName !== undefined) patch.display_name = body.displayName;
    if (body.role !== undefined) patch.role = body.role;
    if (body.isFaculty !== undefined) patch.is_faculty = body.isFaculty;
    if (body.active !== undefined) patch.active = body.active;
    if (body.password) patch.password_hash = await bcrypt.hash(body.password, 12);
    const [row] = await trx('users').where({ id }).update(patch).returning(USER_COLUMNS);
    if (body.active === false) {
      // End the deactivated user's sessions.
      await trx.raw(`delete from session where (sess->>'userId')::bigint = ?`, [id]);
    }
    await logActivity(trx, {
      actorId: admin.id,
      action: 'user.update',
      details: { userId: id, fields: Object.keys(body).filter((k) => k !== 'password'), passwordReset: !!body.password },
    });
    return row;
  });
  res.json({ user: publicUser(result) });
});
