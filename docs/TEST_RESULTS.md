# Test results — 2026-11-09

Environment: Windows 11 (10.0.26200), Intel Core Ultra 9 288V (8 cores), 32 GB
RAM, Node 24.18.0, PostgreSQL via `embedded-postgres` 18.6 on loopback. Chrome
(installed) driven by playwright-core for the browser smoke test.

## Automated integration tests (`npm test`): 36 / 36 passed

These run against a real PostgreSQL database through the full HTTP stack
(sessions, CSRF, authorization).

| Acceptance test | Covered by | Result |
|---|---|---|
| AT-01 curricula/majors filtering, selection clearing | `workflow.test.ts` AT-01 (API) + browser smoke (UI clearing) | Pass |
| AT-02 separate reviews per major | `workflow.test.ts` AT-02/03 | Pass |
| AT-03 exactly Past, Present, Future in order | `workflow.test.ts` AT-02/03 + browser smoke | Pass |
| AT-04 5+ nested levels, reorder, persist after reload | `workflow.test.ts` AT-04 + browser keyboard expand/collapse | Pass |
| AT-05 parent/child ownership independent | `workflow.test.ts` AT-05 | Pass |
| AT-06 backend rejects editing others' responses/assignments | `security.test.ts` AT-06 | Pass |
| AT-07 paragraphs and formatting survive restart | `workflow.test.ts` AT-07 (DB pool and app re-created) | Pass |
| AT-08 blank/markup-only cannot complete | `narrative.test.ts`, `workflow.test.ts` AT-08 | Pass |
| AT-09 complete parent + unfinished child = partial | `workflow.test.ts` AT-09 | Pass |
| AT-10 failed save keeps text, no false completion | `workflow.test.ts` AT-10 (API) + browser smoke (network failure simulated) | Pass |
| AT-11 stale save conflicts | `workflow.test.ts` AT-11 + browser smoke (two sessions) | Pass |
| AT-12 subtree move across sections; cycles/cross-review fail | `workflow.test.ts` AT-12 (×2) | Pass |
| AT-13 archive/restore; progress and reports exclude archived | `workflow.test.ts` AT-13 | Pass |
| AT-14 working and completed reports in tree order | `reports.test.ts` AT-14 (×2) | Pass |
| AT-15 DOCX/PDF readable and complete | `reports.test.ts` AT-15/16 + visual PDF inspection | Pass (DOCX checked automatically; see note) |
| AT-16 snapshot unchanged after later edits | `reports.test.ts` AT-15/16 | Pass |
| AT-17 guessed identifiers rejected | `security.test.ts` AT-17 | Pass |
| AT-18 backup restored into isolated database | `backup.test.ts` | Pass |
| AT-19 isolation before/after deployment | Deployed 2026-11-09; checks recorded in SERVER_INVENTORY.md | Pass |

Additional checks: CSRF rejection, XSS sanitization, inactive-account sign-out,
last-admin protection, revision immutability triggers, archived-review
read-only, search, My Tasks, activity log, health endpoint content.

**AT-15 note:** the PDF (5 pages, nested headings to depth 5, long paragraphs,
nested lists, draft and missing labels, "Page X of Y" footers) was rendered and
inspected visually. One defect was found and fixed: a bullet glyph missing from
the embedded font. The DOCX was verified by parsing `document.xml` (all text,
section order, Heading styles, list numbering, footer PAGE field). It has not yet
been opened in Microsoft Word by a person. Sample files are written to
`server/test-output/` on every test run.

## Browser smoke test (`npm run e2e`): 30 / 30 checks passed

(Rerun after the owner-requested change to a Section dropdown; the checks now cover the dropdown's order, switching sections, switching on task open and on filter, and phone-width screens.)

Review auto-selection; tree order; curriculum change clears major and review;
subtask creation starts unassigned; assignment dropdown; tree keyboard navigation
(arrow keys, collapse, Enter opens editor); no false "unsaved" on open; professor
filter keeps ancestors; My Tasks opens the right review and task; professor sees a
read-only assignment; autosave; simulated network failure shows *Save failed*,
keeps text, and disables completion; retry; two-window conflict with compare and
deliberate overwrite; leaving with unsaved text prompts; completion makes the
editor read-only; snapshot DOCX and PDF downloads; narrow-screen section tabs.

Defects found by this test and fixed: a false "Unsaved changes" state when
opening an empty response; dropdown accessible names that included option text;
the editor drawer covering the top navigation.

## Benchmark (`npm run bench`): 1,000 tasks, light load

The review had 1,000 tasks across three sections (up to 5 levels), 250 assigned
to one professor, 500 with two-paragraph narratives, and 167 complete.

| Operation | Median | p95 |
|---|---|---|
| GET tree (1,000 tasks) | 29 ms | 86 ms |
| Client: build forest + progress | 0.4 ms | 4.5 ms |
| Client: professor filter with ancestors | 0.1 ms | 0.8 ms |
| Search titles + narrative text | 11 ms | 18 ms |
| Open task | 11 ms | 26 ms |
| Save response (new revision) | 14 ms | 21 ms |
| My Tasks (250 items) | 30 ms | 35 ms |
| Report preview | 55 ms | 72 ms |
| Generate snapshot | 98 ms | 112 ms |
| DOCX download (1,000-task snapshot) | 332 ms | 380 ms |
| PDF download (1,000-task snapshot) | 2,451 ms | 2,823 ms |

Ordinary reads and saves stay far under the 2-second target on this machine.
These are development-machine numbers, not a production guarantee. Repeat them
on the target host after deployment.

## Other checks

- `npm run typecheck`: no errors (server and client).
- `npm audit`: 0 known vulnerabilities (all and production-only dependencies).
- Migrations: up → down → up verified, under both TypeScript (tsx) and compiled JavaScript.
- Compiled server (`npm run build && npm start`): serves the UI and API. CSP, HSTS and frame-blocking headers are present.
