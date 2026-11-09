/**
 * Loads SYNTHETIC example data (spec §15) into a local development database.
 * Refuses to run in production or against a database whose name does not
 * end in "_dev". Usage: npm run db:seed [-- --reset]
 */
import bcrypt from 'bcryptjs';
import { closeDb, db } from '../src/db.js';
import { getConfig } from '../src/config.js';

const config = getConfig();
const url = new URL(config.DATABASE_URL);
const dbName = url.pathname.slice(1);
if (config.NODE_ENV === 'production' || !/^programaudit.*_dev$/.test(dbName) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  console.error(`Refusing to seed ${url.hostname}/${dbName}: seeding is only allowed for a local programaudit*_dev database.`);
  process.exit(1);
}
const reset = process.argv.includes('--reset');
const k = db();

try {
  await k.migrate.latest();
  const existing = await k('users').count({ n: '*' }).first();
  if (Number(existing?.n) > 0 && !reset) {
    console.log('Database already has data; nothing seeded. Use `npm run db:seed -- --reset` to wipe and reseed the local dev database.');
    process.exit(0);
  }
  if (reset) {
    await k.raw('alter table response_revisions disable trigger response_revisions_immutable');
    await k.raw('alter table report_snapshots disable trigger report_snapshots_immutable');
    await k.raw('truncate activity_log, report_snapshots, response_revisions, tasks, review_access, reviews, majors, curricula, session, users restart identity cascade');
    await k.raw('alter table response_revisions enable trigger response_revisions_immutable');
    await k.raw('alter table report_snapshots enable trigger report_snapshots_immutable');
  }

  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 10 || /replace-me/.test(adminPassword)) {
    throw new Error('Set SEED_ADMIN_PASSWORD (10+ characters) in .env before seeding');
  }
  const hash = await bcrypt.hash(adminPassword, 10);
  const mk = async (email: string, display_name: string, role: string, extra: Record<string, unknown> = {}) =>
    (await k('users').insert({ email, display_name, role, password_hash: hash, ...extra }).returning('id'))[0].id as number;

  const admin = await mk(process.env.SEED_ADMIN_EMAIL ?? 'admin@example.edu', 'Avery Admin', 'admin', { is_faculty: false });
  const coord = await mk('coordinator@example.edu', 'Casey Coordinator', 'coordinator');
  const PROFESSORS = ['Eric', 'Michael', 'Sam', 'Teri', 'Matt', 'James'];
  const prof: Record<string, number> = {};
  for (const name of PROFESSORS) prof[name] = await mk(`${name.toLowerCase()}@example.edu`, name, 'professor');
  const profA = prof.Eric;
  const profB = prof.Michael;

  const [computing] = await k('curricula').insert({ name: 'Computing' }).returning('id');
  const [business] = await k('curricula').insert({ name: 'Business' }).returning('id');
  const [cyber] = await k('majors').insert({ curriculum_id: computing.id, name: 'Cybersecurity' }).returning('id');
  await k('majors').insert({ curriculum_id: computing.id, name: 'Computer Science' });
  await k('majors').insert({ curriculum_id: business.id, name: 'Accounting' });

  const [review] = await k('reviews')
    .insert({ major_id: cyber.id, title: '2026 Program Review', period: '2021–2026', description: 'Synthetic example review.', created_by: coord })
    .returning('id');
  await k('review_access').insert([
    { review_id: review.id, user_id: coord, access: 'coordinator', granted_by: admin },
    { review_id: review.id, user_id: profA, access: 'faculty', granted_by: coord },
    { review_id: review.id, user_id: profB, access: 'faculty', granted_by: coord },
  ]);

  const task = async (section: string, title: string, parent: number | null, order: number, assignee: number | null, instructions = '') =>
    (
      await k('tasks')
        .insert({ review_id: review.id, section, parent_id: parent, title, instructions, sort_order: order, assignee_id: assignee, created_by: coord, updated_by: coord })
        .returning('id')
    )[0].id as number;

  const past = await task('past', 'Describe changes made after the previous review', null, 10, null, 'Summarize the program changes implemented since the last review.');
  await task('past', 'Explain the effect of revised prerequisites', past, 10, null);
  const present = await task('present', 'Evaluate current learning outcomes', null, 10, null);
  const evidence = await task('present', 'Describe evidence of student achievement', present, 10, profA, 'Cite assessment results for each program learning outcome.');
  const future = await task('future', 'Recommend improvements for the next review period', null, 10, null);
  await task('future', 'Propose changes to course sequencing', future, 10, profB);

  const html =
    '<p>Across the review period, direct assessment of capstone projects showed that <strong>87%</strong> of students met or exceeded the target for secure system design.</p>' +
    '<p>Indirect measures, including exit surveys, were consistent with these results:</p><ul><li><p>Network defense</p></li><li><p>Incident response</p></li></ul>';
  await k('response_revisions').insert({
    task_id: evidence,
    revision_no: 1,
    content_html: html,
    plain_text: 'Across the review period, direct assessment of capstone projects showed that 87% of students met or exceeded the target for secure system design.\n\nIndirect measures, including exit surveys, were consistent with these results:\n\n- Network defense\n\n- Incident response',
    word_count: 38,
    author_id: profA,
  });
  await k('tasks')
    .where({ id: evidence })
    .update({ current_revision_no: 1, status: 'complete', completed_at: k.fn.now(), completed_by: profA, completed_revision_no: 1, updated_by: profA });

  console.log('Seeded synthetic data. Accounts (all use SEED_ADMIN_PASSWORD):');
  console.log(`  ${process.env.SEED_ADMIN_EMAIL ?? 'admin@example.edu'} (admin), coordinator@example.edu (coordinator)`);
  console.log(`  Professors: ${PROFESSORS.map((n) => `${n.toLowerCase()}@example.edu`).join(', ')}`);
} finally {
  await closeDb();
}
