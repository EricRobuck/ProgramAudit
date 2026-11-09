import { Router } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { db } from '../db.js';
import { parseId, requireManage, requireUser, reviewAccess } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { buildReport, type ReportContent, safeFilename } from '../reports/build.js';
import { renderDocx } from '../reports/docx.js';
import { renderPdf } from '../reports/pdf.js';

export const reportsRouter = Router();

const optionsSchema = z.object({
  mode: z.enum(['working', 'completed']),
  attribution: z
    .union([z.boolean(), z.enum(['0', '1', 'true', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});

const snapshotOut = (r: any) => ({
  id: r.id,
  reviewId: r.review_id,
  mode: r.mode,
  options: r.options,
  activeTaskCount: r.active_task_count,
  completedTaskCount: r.completed_task_count,
  createdAt: r.created_at,
  createdBy: r.created_by_name ?? r.created_by,
});

/** Live preview of what a report would contain right now. Nothing is stored. */
reportsRouter.get('/reviews/:id/report-preview', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  await reviewAccess(user, id);
  const opts = parse(optionsSchema, req.query);
  const { content } = await buildReport(id, opts.mode, { attribution: opts.attribution }, user.display_name, user.timezone);
  res.json({ content });
});

/** Creates an immutable snapshot from one consistent read of saved revisions. */
reportsRouter.post('/reviews/:id/reports', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  const opts = parse(optionsSchema, req.body);
  const row = await db().transaction(
    async (trx) => {
      await requireManage(user, id, trx, { allowArchived: true });
      const { content, sourceRevisions } = await buildReport(
        id,
        opts.mode,
        { attribution: opts.attribution },
        user.display_name,
        user.timezone,
        trx,
      );
      const [snap] = await trx('report_snapshots')
        .insert({
          review_id: id,
          mode: opts.mode,
          options: JSON.stringify({ attribution: opts.attribution }),
          content: JSON.stringify(content),
          source_revisions: JSON.stringify(sourceRevisions),
          active_task_count: content.progress.total,
          completed_task_count: content.progress.completed,
          created_by: user.id,
        })
        .returning('*');
      await logActivity(trx, {
        actorId: user.id,
        action: 'report.generate',
        reviewId: id,
        details: { snapshotId: snap.id, mode: opts.mode, revisions: sourceRevisions.length },
      });
      return snap;
    },
    { isolationLevel: 'repeatable read' } as Knex.TransactionConfig,
  );
  res.status(201).json({ snapshot: { ...snapshotOut({ ...row, created_by_name: user.display_name }), content: row.content } });
});

reportsRouter.get('/reviews/:id/reports', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  await reviewAccess(user, id);
  const rows = await db()('report_snapshots as s')
    .join('users as u', 'u.id', 's.created_by')
    .where('s.review_id', id)
    .select('s.id', 's.review_id', 's.mode', 's.options', 's.active_task_count', 's.completed_task_count', 's.created_at', 'u.display_name as created_by_name')
    .orderBy('s.id', 'desc');
  res.json({ snapshots: rows.map(snapshotOut) });
});

async function loadSnapshot(req: Parameters<Parameters<typeof reportsRouter.get>[1]>[0]) {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  const peek = await db()('report_snapshots').where({ id }).select('review_id').first();
  if (!peek) throw notFound('Report not found');
  await reviewAccess(user, peek.review_id);
  const row = await db()('report_snapshots as s')
    .join('users as u', 'u.id', 's.created_by')
    .where('s.id', id)
    .select('s.*', 'u.display_name as created_by_name')
    .first();
  return row;
}

reportsRouter.get('/reports/:id', async (req, res) => {
  const row = await loadSnapshot(req);
  res.json({ snapshot: { ...snapshotOut(row), content: row.content, sourceRevisions: row.source_revisions } });
});

reportsRouter.get('/reports/:id/download', async (req, res) => {
  const row = await loadSnapshot(req);
  const { format } = parse(z.object({ format: z.enum(['docx', 'pdf']) }), req.query);
  const content = row.content as ReportContent;
  const buffer = format === 'docx' ? await renderDocx(content) : await renderPdf(content);
  const filename = safeFilename(content, row.id, format);
  res.setHeader(
    'Content-Type',
    format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});
