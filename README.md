# ProgramAudit

A web application for curriculum audits and program reviews. Coordinators build
**Past / Present / Future** task trees for a review, assign tasks to faculty, and
compile the faculty's narrative responses into a report. Faculty write and
complete their assigned narratives.

Workflow: **Curriculum → Major → Review → Past / Present / Future trees → assign
faculty → write and complete responses → compile report (preview, DOCX, PDF).**

> Status: first release, built and tested locally with synthetic data.
> **Not deployed.** See [docs/DEPLOYMENT_PLAN.md](docs/DEPLOYMENT_PLAN.md) for the
> isolated deployment plan and the decisions still needed from the owner.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite, React Router, TipTap rich-text editor |
| Backend | Node.js 24, Express 5, TypeScript, Zod validation |
| Database | PostgreSQL (Knex query builder and reversible migrations) |
| Auth | Individual accounts, bcrypt password hashes, server-side sessions stored in PostgreSQL |
| Exports | `docx` (Word) and `pdfmake` (PDF), rendered from immutable snapshots |
| Tests | Vitest + Supertest integration tests against real PostgreSQL; Playwright smoke test in a real browser |

The GitHub repository was empty, so this stack was chosen as a small, maintained
setup that fits a modest AWS host. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (local development)

Requirements: Node.js 20+ (developed on 24.18), npm 10+. No Docker or system
PostgreSQL install is required for development; real PostgreSQL binaries run
on loopback via the `embedded-postgres` package.

```bash
npm install
cp .env.example .env                 # then set SESSION_SECRET and SEED_ADMIN_PASSWORD
npm run db:start                     # terminal 1: local PostgreSQL on 127.0.0.1:54329 (data in ./.data)
npm run db:migrate                   # terminal 2
npm run db:seed                      # synthetic example data (spec §15)
npm run dev:server                   # API on http://127.0.0.1:4100
npm run dev:client                   # terminal 3: UI on http://127.0.0.1:5173 (proxies /api)
```

Sign in with the seeded accounts. All of them use `SEED_ADMIN_PASSWORD` from `.env`:

| Email | Role |
|---|---|
| `admin@example.edu` (or `SEED_ADMIN_EMAIL`) | Administrator |
| `coordinator@example.edu` | Review coordinator (coordinates the 2026 Program Review) |
| `eric@example.edu` | Professor Eric (one completed task) |
| `michael@example.edu` | Professor Michael (one assigned task) |
| `sam@example.edu`, `teri@example.edu`, `matt@example.edu`, `james@example.edu` | Professors Sam, Teri, Matt, James (available for assignment) |

To wipe and reseed the **local dev** database: `npm run db:seed -- --reset`.
The seed script refuses to run unless the database is a local `programaudit*_dev` database.

### Production-style local run

```bash
npm run build      # compiles server to server/dist and client to client/dist
npm start          # serves API and built UI on PORT (default 4100)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run db:start` | Start the local loopback PostgreSQL (development and tests only) |
| `npm run db:migrate` / `npm run db:rollback` | Apply or roll back migrations (refuses databases without "programaudit" in the name) |
| `npm run db:seed [-- --reset]` | Load synthetic data into the local dev database |
| `npm run dev:server` / `npm run dev:client` | Development servers with reload |
| `npm test` | Integration and unit tests (uses `TEST_DATABASE_URL`, which they reset) |
| `npm run typecheck` | TypeScript checks for server and client |
| `npm run build` / `npm start` | Production build / run |
| `npm run bench` | 1,000-task performance benchmark (resets the test database) |
| `npm run e2e` | Browser smoke test against a running, freshly seeded instance (see below) |
| `npm run backup -- <file>` / `npm run restore -- <file>` | Logical JSON backup / restore (see [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)) |

Browser smoke test (needs Chrome installed; the app must be running and freshly seeded):

```bash
npm run db:seed -- --reset && npm start   # in one terminal
SEED_PASSWORD=<SEED_ADMIN_PASSWORD> BASE_URL=http://127.0.0.1:4100 npm run e2e
```

## Repository layout

```
server/
  src/app.ts            Express app: security headers, sessions, CSRF, routes, error handling
  src/routes/           auth, users, catalog (curricula/majors), reviews, tasks, reports
  src/services/tasks.ts Tree operations, assignment, narrative saves, completion, history
  src/reports/          Report compilation (build.ts) and DOCX/PDF renderers
  src/lib/              Authorization, narrative sanitization, activity log, backup
  migrations/           Reversible schema migrations
  scripts/              local-db, migrate, seed, backup/restore, bench
  test/                 Integration tests mapped to the acceptance tests
client/src/
  pages/                Workspace (selection + trees), My tasks, Report, Administration, Account
  components/           TreePanel, TaskEditor, RichEditor, dialogs
deploy/                 Isolated docker-compose definition, env template, proxy examples
docs/                   Architecture, deployment plan, backup/restore, test results
e2e/smoke.mjs           Browser smoke test (playwright-core driving installed Chrome)
```

## Roles

| Role | Can do |
|---|---|
| Administrator | Manage accounts, faculty roster, curricula, majors, and coordinator access; manage every review |
| Review coordinator | Create reviews; manage the reviews they coordinate: tasks, structure, assignments, due dates, narratives, reopening, reports |
| Professor | Read reviews they participate in; edit and complete tasks assigned to them; preview reports and download existing snapshots |

The server enforces authorization on every request, including exports. An
identifier the caller cannot access returns 404, so IDs cannot be probed.

## Key behaviors

- **One section at a time.** A *Section* dropdown (Past / Present / Future, with progress or match counts) shows one full-width tree. The view switches to a task's section when you open it from My Tasks, and to a section with matches when a filter is applied.
- **Three permanent sections.** Past, Present and Future are fixed by the schema, not stored as rows, so they can't be deleted or reordered. Tasks nest up to 10 levels.
- **Ownership is per node.** Assigning a parent never changes its children. New tasks start unassigned. Only active faculty accounts can be assigned.
- **Saving.** Autosave runs 1.5 s after typing stops; there is also a Save button and Ctrl+S. The indicator reads *Unsaved changes*, *Saving…*, *All changes saved*, *Save failed* (with Retry), or *Not saved — conflict*. Text stays in the editor whenever a save fails. Leaving with pending, failed or conflicting work asks for confirmation.
- **Conflicts.** Each save names the revision it was based on. If someone else saved in between, the server returns 409 and keeps the newer text. The editor offers *compare*, *save my text as newest*, or *discard mine*.
- **Completion** requires the latest response to be saved and to contain visible text. Blank paragraphs, markup alone, and empty lists don't count. A completed response is read-only until a coordinator reopens it; reopening is recorded.
- **Progress** counts nodes: completed active nodes ÷ all active nodes, per branch, section, and review. A review with no tasks shows "No tasks".
- **History.** Every save is an immutable revision with author and time. Coordinators can view and restore an earlier revision, which is saved as a new revision.
- **Archive, not delete.** Archiving a subtree shows the descendant count first, hides the tasks from progress and new reports, and can be undone. Revisions and report snapshots are append-only; database triggers block updates and deletes.
- **Reports.** A *working* report includes every active task, labeled as draft or missing where applicable, with assignee and status. A *completed-response* report includes only completed narratives, plus ancestor headings for context and optional contributor names. Generating a report stores an immutable snapshot, read in one REPEATABLE READ transaction. Re-downloading a snapshot always produces the same content. Incomplete reviews are labeled as incomplete and are never called final.
- **Times.** Timestamps are stored as UTC and shown in each user's chosen timezone (Account page). Due dates are plain calendar dates that never shift, and "overdue" uses the user's local date.

## Security notes

- Passwords are hashed with bcrypt (cost 12). Sign-ins are throttled per address and email. The session ID is regenerated at sign-in, and deactivating an account ends its sessions.
- Session cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` when `COOKIE_SECURE=true` (required for deployment).
- CSRF protection: a per-session token in `X-CSRF-Token`, a required custom header, and Origin checks on every state-changing request.
- Narrative HTML is sanitized on the server to a strict allowlist (`p, br, strong, em, ul, ol, li`, with no attributes) before storage.
- Helmet sets a restrictive CSP and other security headers. All SQL is parameterized.
- Logs never include request bodies, passwords, tokens or narrative text. `/api/health` reports only liveness and database reachability.
- Credentials stay out of git: `.env` is ignored, and `.env.example` and `deploy/.env.production.example` contain placeholders only.

## Known limitations (first release)

- No email notifications, evidence-file uploads, LMS integration, AI assistance, or real-time co-editing. These are out of scope per the spec.
- Accounts are local. Institutional SSO (SAML/OIDC) is a pending owner decision.
- Sign-in throttling is in memory, so it resets on restart and isn't shared across instances. That's fine for a single instance.
- Exporting a very large review to PDF is slow: about 2.5 s for 1,000 tasks on the development machine.
- DOCX output was checked automatically (text, order, headings, numbering, page-number fields) and PDF output was inspected visually. The DOCX has not yet been opened in Microsoft Word by a person.
- Faculty can ask for a completed task to be reopened only outside the app; the spec makes an in-app request workflow optional.
- Professors can read all narratives in reviews they participate in (read-only, for context), but cannot edit them.

See [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md) for test and benchmark results.
