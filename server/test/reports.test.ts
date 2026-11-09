import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db.js';
import { addTask, type Client, complete, createUser, login, resetDb, save, scaffoldReview } from './helpers.js';

let admin: Client, coord: Client, profA: Client, profB: Client;
let reviewId: number;
const t: Record<string, number> = {};
const outDir = path.resolve(import.meta.dirname, '..', 'test-output');

const LONG = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} of a deliberately long paragraph about curriculum assessment, program outcomes, and evidence gathered across several academic years.`).join(' ');

beforeAll(async () => {
  await resetDb();
  fs.mkdirSync(outDir, { recursive: true });
  const a = await createUser('admin', 'Report Admin');
  const c = await createUser('coordinator', 'Report Coord');
  const pa = await createUser('professor', 'Professor A');
  const pb = await createUser('professor', 'Professor B');
  admin = await login(a.email);
  coord = await login(c.email);
  profA = await login(pa.email);
  profB = await login(pb.email);
  reviewId = (await scaffoldReview(admin, coord)).review.id;

  // Spec §15 example plus extra depth.
  t.past = (await addTask(coord, reviewId, 'past', 'Describe changes made after the previous review')).id;
  t.pastSub = (await addTask(coord, reviewId, 'past', 'Explain the effect of revised prerequisites', t.past)).id;
  t.present = (await addTask(coord, reviewId, 'present', 'Evaluate current learning outcomes')).id;
  t.evidence = (await addTask(coord, reviewId, 'present', 'Describe evidence of student achievement', t.present)).id;
  t.deep1 = (await addTask(coord, reviewId, 'present', 'Outcome 1 detail', t.evidence)).id;
  t.deep2 = (await addTask(coord, reviewId, 'present', 'Outcome 1 sub-detail', t.deep1)).id;
  t.deep3 = (await addTask(coord, reviewId, 'present', 'Outcome 1 deepest detail', t.deep2)).id;
  t.future = (await addTask(coord, reviewId, 'future', 'Recommend improvements for the next review period')).id;
  t.sequencing = (await addTask(coord, reviewId, 'future', 'Propose changes to course sequencing', t.future)).id;
  await coord.put(`/api/tasks/${t.evidence}/assignee`, { assigneeId: pa.id });
  await coord.put(`/api/tasks/${t.sequencing}/assignee`, { assigneeId: pb.id });

  await save(profA, t.evidence, `<p>${LONG}</p><p>Second paragraph with <strong>bold</strong> and <em>italic</em> text.</p><ol><li><p>First numbered</p><ul><li><p>Nested bullet</p></li></ul></li><li><p>Second numbered</p></li></ol>`);
  await complete(profA, t.evidence);
  await save(coord, t.present, '<p>Parent narrative for Present.</p>');
  await complete(coord, t.present);
  await save(coord, t.deep3, `<p>${LONG}</p>`);
  await complete(coord, t.deep3);
  await save(profB, t.sequencing, '<p>Draft about sequencing.</p>'); // left in progress
});
afterAll(async () => closeDb());

const titlesOf = (content: any, key: string) => content.sections.find((s: any) => s.key === key).nodes.map((n: any) => [n.title, n.kind]);

describe('report compilation', () => {
  it('AT-14: working report includes every active task in tree order with labels', async () => {
    const c = (await coord.get(`/api/reviews/${reviewId}/report-preview?mode=working`)).body.content;
    expect(c.sections.map((s: any) => s.label)).toEqual(['Past', 'Present', 'Future']);
    expect(titlesOf(c, 'past')).toEqual([
      ['Describe changes made after the previous review', 'missing'],
      ['Explain the effect of revised prerequisites', 'missing'],
    ]);
    expect(titlesOf(c, 'present')).toEqual([
      ['Evaluate current learning outcomes', 'narrative'],
      ['Describe evidence of student achievement', 'narrative'],
      ['Outcome 1 detail', 'missing'],
      ['Outcome 1 sub-detail', 'missing'],
      ['Outcome 1 deepest detail', 'narrative'],
    ]);
    expect(titlesOf(c, 'future')).toEqual([
      ['Recommend improvements for the next review period', 'missing'],
      ['Propose changes to course sequencing', 'draft'],
    ]);
    const ev = c.sections[1].nodes[1];
    expect(ev).toMatchObject({ assignee: 'Professor A', status: 'complete', outline: '1.1', depth: 2 });
    expect(ev.blocks[0].runs[0].text).toBe(LONG); // verbatim, not summarized
    expect(c.allComplete).toBe(false);
    expect(c.progress).toEqual({ completed: 3, total: 9 });
    expect(c.unresolved).toHaveLength(6);
  });

  it('AT-14: completed-response report keeps only completed narratives plus context headings', async () => {
    const c = (await coord.get(`/api/reviews/${reviewId}/report-preview?mode=completed`)).body.content;
    expect(titlesOf(c, 'past')).toEqual([]);
    expect(titlesOf(c, 'present')).toEqual([
      ['Evaluate current learning outcomes', 'narrative'],
      ['Describe evidence of student achievement', 'narrative'],
      ['Outcome 1 detail', 'context'],
      ['Outcome 1 sub-detail', 'context'],
      ['Outcome 1 deepest detail', 'narrative'],
    ]);
    expect(titlesOf(c, 'future')).toEqual([]);
    expect(c.counts).toMatchObject({ excludedTasks: 6, includedNarratives: 3, unfinishedTasks: 6 });
    const context = c.sections[1].nodes[2];
    expect(context.blocks).toEqual([]);
  });

  it('AT-15 / AT-16: snapshots are immutable and DOCX/PDF exports are complete and readable', async () => {
    const snapW = (await coord.post(`/api/reviews/${reviewId}/reports`, { mode: 'working' })).body.snapshot;
    const snapC = (await coord.post(`/api/reviews/${reviewId}/reports`, { mode: 'completed', attribution: true })).body.snapshot;
    expect(snapW.content.mode).toBe('working');

    const docx = await coord.get(`/api/reports/${snapW.id}/download?format=docx`).buffer(true).parse(binaryParser);
    expect(docx.status).toBe(200);
    expect(docx.headers['content-disposition']).toMatch(/^attachment; filename="Cybersecurity_2026-Program-Review_working_\d{8}-\d{4}Z_snapshot-\d+\.docx"$/);
    const zip = await JSZip.loadAsync(docx.body);
    const xml = await zip.file('word/document.xml')!.async('string');
    const text = xml.replace(/<[^>]+>/g, '');
    for (const s of ['Past', 'Present', 'Future', 'Describe evidence of student achievement', 'Outcome 1 deepest detail', 'DRAFT — not yet marked complete', 'No response yet.', 'Nested bullet', 'Incomplete: 3 of 9']) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain(LONG);
    expect(text.indexOf('Past')).toBeLessThan(text.indexOf('Evaluate current learning outcomes'));
    expect(text.indexOf('Evaluate current learning outcomes')).toBeLessThan(text.indexOf('Recommend improvements'));
    expect(xml).toMatch(/Heading2/);
    expect(text).not.toMatch(/\bfinal\b/i);
    const footer = Object.keys(zip.files).find((f) => /word\/footer\d*\.xml/.test(f))!;
    expect(await zip.file(footer)!.async('string')).toMatch(/PAGE/);
    fs.writeFileSync(path.join(outDir, 'working-report.docx'), docx.body);

    const pdf = await coord.get(`/api/reports/${snapC.id}/download?format=pdf`).buffer(true).parse(binaryParser);
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (pdf.body.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(4); // cover + one page per section
    fs.writeFileSync(path.join(outDir, 'completed-report.pdf'), pdf.body);
    const pdfW = await coord.get(`/api/reports/${snapW.id}/download?format=pdf`).buffer(true).parse(binaryParser);
    fs.writeFileSync(path.join(outDir, 'working-report.pdf'), pdfW.body);
    const docxC = await coord.get(`/api/reports/${snapC.id}/download?format=docx`).buffer(true).parse(binaryParser);
    fs.writeFileSync(path.join(outDir, 'completed-report.docx'), docxC.body);
    const cText = (await (await JSZip.loadAsync(docxC.body)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, '');
    expect(cText).toContain('Contributor: Professor A');
    expect(cText).not.toContain('Draft about sequencing');

    // AT-16: edit after generating; the stored snapshot and re-download do not change.
    await coord.post(`/api/tasks/${t.evidence}/reopen`);
    await save(profA, t.evidence, '<p>Rewritten after the snapshot.</p>');
    const again = (await coord.get(`/api/reports/${snapW.id}`)).body.snapshot;
    expect(again.content).toEqual(snapW.content);
    expect(again.sourceRevisions).toContainEqual({ taskId: t.evidence, revisionNo: 1 });
    const docx2 = await coord.get(`/api/reports/${snapW.id}/download?format=docx`).buffer(true).parse(binaryParser);
    const text2 = (await (await JSZip.loadAsync(docx2.body)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, '');
    expect(text2).toContain(LONG);
    expect(text2).not.toContain('Rewritten after the snapshot.');
    // A new snapshot reflects the new state.
    const snap3 = (await coord.post(`/api/reviews/${reviewId}/reports`, { mode: 'working' })).body.snapshot;
    expect(JSON.stringify(snap3.content)).toContain('Rewritten after the snapshot.');
    expect(snap3.content.progress.completed).toBe(2);
    // Snapshots cannot be altered or deleted, even directly.
    await expect(db()('report_snapshots').where({ id: snapW.id }).del()).rejects.toThrow(/immutable/);
    // Professors in the review can download existing snapshots.
    expect((await profB.get(`/api/reports/${snapW.id}/download?format=pdf`)).status).toBe(200);
    expect((await coord.get(`/api/reviews/${reviewId}/reports`)).body.snapshots).toHaveLength(3);
  });

  it('empty sections are labeled', async () => {
    const r = (await coord.post('/api/reviews', { majorId: (await coord.get(`/api/reviews/${reviewId}`)).body.major.id, title: 'Empty review' })).body.review;
    const snap = (await coord.post(`/api/reviews/${r.id}/reports`, { mode: 'working' })).body.snapshot;
    expect(snap.content.progress).toEqual({ completed: 0, total: 0 });
    const docx = await coord.get(`/api/reports/${snap.id}/download?format=docx`).buffer(true).parse(binaryParser);
    const text = (await (await JSZip.loadAsync(docx.body)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, '');
    expect(text.match(/No content\./g)).toHaveLength(3);
    expect(text).toContain('No tasks have been defined');
  });
});

function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
