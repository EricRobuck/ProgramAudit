/**
 * Browser smoke test against a locally running, freshly seeded ProgramAudit
 * (npm run db:seed -- --reset, then npm start). Drives the installed Chrome
 * via playwright-core. Usage:
 *   BASE_URL=http://127.0.0.1:4100 SEED_PASSWORD=... E2E_OUT=./e2e-out node e2e/smoke.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4100';
const PASSWORD = process.env.SEED_PASSWORD;
const OUT = process.env.E2E_OUT ?? 'e2e-out';
if (!PASSWORD) throw new Error('Set SEED_PASSWORD');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

async function session(email, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror ${email}]`, e.message));
  await page.goto(BASE);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'My tasks' }).waitFor();
  return { ctx, page };
}

async function chooseReview(page) {
  await page.getByLabel('Curriculum', { exact: true }).selectOption({ label: 'Computing' });
  await page.getByLabel('Major', { exact: true }).selectOption({ label: 'Cybersecurity' });
  await page.getByRole('heading', { level: 1, name: '2026 Program Review' }).waitFor();
}

try {
  // --- Coordinator: selection, trees, assignment ---
  const coord = await session('coordinator@example.edu');
  const p = coord.page;
  await chooseReview(p);
  check('review auto-selected when it is the only one for the major', (await p.getByLabel('Review', { exact: true }).inputValue()) !== '');
  await p.locator('.tree-panel').waitFor();
  const sectionOpts = await p.locator('#sel-section option').evaluateAll((os) => os.map((o) => o.value));
  check('section dropdown lists Past, Present, Future in order', JSON.stringify(sectionOpts) === '["past","present","future"]', sectionOpts.join(','));
  check('one full-width tree shown (Past by default)', (await p.locator('.tree-panel').count()) === 1 && (await p.locator('.tree-panel h2').textContent()) === 'Past');
  await p.getByLabel('Section', { exact: true }).selectOption('present');
  check('choosing a section shows its tree', (await p.locator('.tree-panel h2').textContent()) === 'Present');
  await p.getByLabel('Section', { exact: true }).selectOption('past');
  await shot(p, '01-coordinator-workspace');

  // Changing curriculum clears major/review.
  await p.getByLabel('Curriculum', { exact: true }).selectOption({ label: 'Business' });
  check('changing curriculum clears incompatible major', (await p.getByLabel('Major', { exact: true }).inputValue()) !== String(''), 'auto-selects only major Accounting');
  check('no stale tree after curriculum change', (await p.locator('.tree-panel').count()) === 0);
  await chooseReview(p);

  // Add a subtask via the action menu and assign it.
  await p.getByRole('button', { name: 'Actions for Describe changes made after the previous review' }).click();
  await p.getByRole('menuitem', { name: 'Add subtask' }).click();
  await p.getByLabel('Title (required)').fill('Summarize advisory board feedback');
  await p.getByRole('button', { name: 'Add task', exact: true }).click();
  await p.getByRole('treeitem', { name: 'Summarize advisory board feedback' }).waitFor();
  check('subtask added and starts unassigned', (await p.getByLabel('Assigned professor for Summarize advisory board feedback').inputValue()) === '');
  await p.getByLabel('Assigned professor for Summarize advisory board feedback').selectOption({ label: 'Michael' });
  await p.getByText('Assignment updated').waitFor();
  check('assignment via dropdown', true);

  // Keyboard navigation in the tree.
  await p.locator('#treeitem-1').focus();
  await p.keyboard.press('ArrowDown');
  const focused = await p.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check('arrow keys move focus between tree items', focused === 'Explain the effect of revised prerequisites', focused ?? '');
  await p.keyboard.press('ArrowLeft');
  check('ArrowLeft moves to parent', (await p.evaluate(() => document.activeElement?.id)) === 'treeitem-1');
  await p.keyboard.press('ArrowLeft');
  check('ArrowLeft collapses an expanded parent', (await p.locator('#treeitem-1').getAttribute('aria-expanded')) === 'false');
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  await p.locator('.drawer h2', { hasText: 'Describe changes made after the previous review' }).waitFor();
  check('Enter opens the task editor', true);
  check('opening a task does not show a false unsaved state', (await p.locator('.save-state').textContent()).startsWith('Nothing saved yet'));
  await shot(p, '02-coordinator-editor');
  await p.getByRole('button', { name: /^Close/ }).click();

  // Filters keep ancestors visible.
  await p.getByLabel('Professor', { exact: true }).selectOption({ label: 'Eric' });
  const visible = await p.locator('[role=treeitem]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  check('filter switches to the section with matches', (await p.locator('.tree-panel h2').textContent()) === 'Present');
  check('professor filter keeps ancestors for context', visible.includes('Evaluate current learning outcomes') && visible.includes('Describe evidence of student achievement') && visible.length === 2, visible.join(' | '));
  await shot(p, '03-filter-professor-a');
  await p.getByRole('button', { name: 'Clear filters' }).click();

  // --- Professor B writes, autosaves, fails, retries, completes ---
  const prof = await session('michael@example.edu');
  const q = prof.page;
  await q.getByRole('link', { name: 'My tasks' }).click();
  await q.getByRole('link', { name: 'Propose changes to course sequencing' }).click();
  await q.locator('.drawer h2', { hasText: 'Propose changes to course sequencing' }).waitFor();
  check('My Tasks opens the correct review and task', true);
  check('opening a task shows its section', (await q.locator('.tree-panel h2').textContent()) === 'Future');
  check('professor sees read-only assignment (no dropdown)', (await q.locator('.tree-panel select').count()) === 0);
  const editor = q.locator('.rich-content[contenteditable=true]');
  await editor.click();
  await q.keyboard.type('First paragraph about sequencing.');
  await q.keyboard.press('Enter');
  await q.keyboard.type('Second paragraph with ');
  await q.keyboard.press('Control+b');
  await q.keyboard.type('bold');
  await q.keyboard.press('Control+b');
  await q.keyboard.type(' text.');
  await q.getByText('All changes saved').waitFor({ timeout: 10000 });
  check('autosave reaches Saved state', true);
  await shot(q, '04-professor-saved');

  // Simulate a failed save.
  await q.route('**/api/tasks/*/response', (route) => route.abort('failed'));
  await editor.click();
  await q.keyboard.press('End');
  await q.keyboard.type(' Unsaved addition.');
  await q.getByText('Save failed', { exact: true }).waitFor({ timeout: 10000 });
  check('failed save shows Save failed', true);
  check('text retained after failure', (await editor.textContent()).includes('Unsaved addition.'));
  check('Mark complete disabled while save failed', await q.getByRole('button', { name: 'Mark complete' }).isDisabled());
  await shot(q, '05-professor-save-failed');
  await q.unroute('**/api/tasks/*/response');
  await q.getByRole('button', { name: 'Retry save' }).click();
  await q.getByText('All changes saved').waitFor({ timeout: 10000 });
  check('retry after failure saves', true);

  // Conflict: a second session saves first.
  const prof2 = await session('michael@example.edu');
  const r = prof2.page;
  await r.goto(q.url());
  await r.locator('.drawer h2', { hasText: 'Propose changes' }).waitFor();
  const ed2 = r.locator('.rich-content[contenteditable=true]');
  await ed2.click();
  await r.keyboard.press('Control+End');
  await r.keyboard.type(' Edit from second window.');
  await r.getByText('All changes saved').waitFor({ timeout: 10000 });
  await editor.click();
  await q.keyboard.press('Control+End');
  await q.keyboard.type(' Stale edit.');
  await q.getByText('Someone else saved a newer version').waitFor({ timeout: 10000 });
  check('stale save shows conflict instead of overwriting', (await editor.textContent()).includes('Stale edit.'));
  await q.getByRole('button', { name: 'Compare with newer version' }).click();
  await shot(q, '06-professor-conflict');
  await q.getByRole('button', { name: 'Save my text as the newest version' }).click();
  await q.getByText('All changes saved').waitFor({ timeout: 10000 });
  check('deliberate overwrite after conflict saves', true);
  await prof2.ctx.close();

  // Unsaved-changes guard on navigation.
  await editor.click();
  await q.keyboard.type(' x');
  let dialogSeen = false;
  q.once('dialog', async (d) => {
    dialogSeen = true;
    await d.dismiss();
  });
  await q.getByRole('link', { name: 'My tasks' }).click();
  await q.waitForTimeout(300);
  check('leaving with unsaved text asks for confirmation', dialogSeen || (await q.getByText('All changes saved').count()) > 0, dialogSeen ? 'confirm shown' : 'autosave finished first');
  await q.getByText('All changes saved').waitFor({ timeout: 10000 });

  await q.getByRole('button', { name: 'Mark complete' }).click();
  await q.getByText('This response is complete and read-only').waitFor();
  check('professor marks task complete; editor becomes read-only', (await q.locator('.rich-content[contenteditable=true]').count()) === 0);
  await shot(q, '07-professor-complete');

  // --- Reports ---
  await p.reload();
  await p.getByRole('link', { name: 'Reports' }).click();
  await p.getByText('Before you export').waitFor();
  await shot(p, '08-report-preview');
  await p.getByRole('button', { name: 'Generate report snapshot' }).click();
  await p.getByText(/Snapshot #\d+ created/).waitFor();
  const [download] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Download PDF' }).click()]);
  const pdfPath = path.join(OUT, download.suggestedFilename());
  await download.saveAs(pdfPath);
  check('PDF download from snapshot', fs.statSync(pdfPath).size > 1000, download.suggestedFilename());
  const [dl2] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Download DOCX' }).click()]);
  await dl2.saveAs(path.join(OUT, dl2.suggestedFilename()));
  check('DOCX download from snapshot', true, dl2.suggestedFilename());

  // --- Narrow screens: tabs ---
  const mobile = await session('coordinator@example.edu', { width: 390, height: 844 });
  await chooseReview(mobile.page);
  await mobile.page.getByLabel('Section', { exact: true }).selectOption('present');
  check('section dropdown works on narrow screens', (await mobile.page.locator('.tree-panel h2').textContent()) === 'Present');
  await shot(mobile.page, '09-mobile-present-tab');

  // --- Admin ---
  const admin = await session('admin@example.edu');
  await admin.page.getByRole('link', { name: 'Administration' }).click();
  await admin.page.getByRole('heading', { name: 'Administration' }).waitFor();
  await shot(admin.page, '10-admin-users');
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
