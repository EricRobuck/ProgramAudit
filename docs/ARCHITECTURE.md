# Architecture and current state

## 1. Starting state (inspected 2026-11-09)

- Local folder `C:\Alvernia\ProgramAudit` was empty and not a git repository.
- GitHub `EricRobuck/ProgramAudit` exists and is **public and empty** (no
  default branch). No `AGENTS.md` or other conventions existed to reuse.
- The AWS server (18.219.232.76) and the existing application
  (`https://18-219-232-76.sslip.io/`) were **not accessed**. Their stack,
  ports, proxy and capacity are unknown. See [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

## 2. Architecture

```
Browser (React SPA)
   │  same-origin HTTPS, session cookie + CSRF token
   ▼
Express API (Node 24)  ──  serves built SPA from client/dist in production
   │  parameterized SQL via Knex
   ▼
PostgreSQL (ProgramAudit-only database and role)
```

One Node process serves both the API and the static client. That makes it a
single container behind whatever reverse proxy the server already uses (or a new
ProgramAudit-only one), bound to loopback only.

### Why this stack

- **PostgreSQL**: relational integrity (composite foreign keys, check
  constraints, triggers) is central to the spec's integrity rules.
- **Express + Knex** instead of a heavier framework or ORM, because tree
  operations rely on recursive CTEs, row locks and explicit transactions, which
  are clearer in SQL.
- **TipTap**: a maintained, accessible editor that can be limited to exactly
  paragraphs, bold, italic and lists, matching the server's sanitizer allowlist.
- **docx / pdfmake**: pure JavaScript, so no headless browser or LibreOffice is
  needed on the server.

## 3. Data model

| Table | Notes |
|---|---|
| `users` | email (case-insensitive unique), display name, role (`admin`/`coordinator`/`professor`), `is_faculty`, `active`, timezone, bcrypt hash |
| `curricula`, `majors` | archived via `archived_at`; a major belongs to exactly one curriculum |
| `reviews` | major, title (unique per major), period, description, archive state |
| `review_access` | (review, user) → `coordinator` or `faculty` |
| `tasks` | review, section (`past`/`present`/`future` check constraint), parent, title, instructions, assignee, due date (`date`), status, sibling `sort_order`, `current_revision_no`, completion/reopen/archive metadata, creator/last editor |
| `response_revisions` | append-only (trigger blocks UPDATE/DELETE); sanitized HTML, plain text (for search), word count, author, `restored_from_revision_no` |
| `report_snapshots` | append-only; frozen report JSON, `(taskId, revisionNo)` source list, mode/options, creator, time |
| `activity_log` | actor, review, task, action, JSON details (no narrative text) |
| `session` | server-side sessions |

Integrity rules enforced by the database:

- `FOREIGN KEY (parent_id, review_id, section) REFERENCES tasks (id, review_id, section) ON UPDATE CASCADE`:
  a parent must be in the same review and section, and moving a task to another
  section cascades the new section through its whole subtree.
- `CHECK (parent_id <> id)`; completion consistency
  (`status = 'complete'` ⇔ completion time and revision are set).
- `ON DELETE RESTRICT` on every foreign key: nothing cascades into responses
  or snapshots.

Integrity rules enforced in transactions (the review row is locked `FOR UPDATE`
to serialize structural edits):

- Cycle prevention (a new parent may not be the task or any descendant), and
  rejection of cross-review parents.
- Depth limit (10 levels) checked against the entire moved subtree.
- Optimistic concurrency on responses (`baseRevisionNo` must equal
  `current_revision_no`).
- Completion records the exact revision it covers in the same statement.

## 4. Authorization

`reviewAccess()` resolves the caller's effective access to a review: `admin`
(all reviews), `coordinator` (needs both the coordinator role and a coordinator
access row), or `faculty` (any access row). A caller with no access gets **404**.
Every task, revision, report and export endpoint resolves the parent review
first and checks access before reading anything else.

- Narrative edits: review managers, or the task's current assignee.
- Structure, assignment, due dates, reopen, history restore, and snapshot
  generation: managers only.
- Coordinator access rows can only be granted by administrators.
- Assigning a professor automatically grants faculty access to that review.

## 5. Decisions made on the owner's behalf (adjustable)

These are spec "proposed defaults" implemented as described; flag any you want changed:

1. Global roles plus per-review access rows; coordinators can create reviews.
2. Faculty participants can read all narratives in their review (read-only context) and preview reports.
3. Maximum nesting depth of 10 (spec minimum: 5).
4. A response status moves to *In progress* on the first save with visible text, and never automatically back to *Not started*.
5. A completed task's metadata (title, instructions, due date) stays editable by coordinators; its narrative does not.
6. Restoring an archived task restores the descendants archived with it in the same action. Restoring a child of an archived parent is refused until the parent is restored.
7. Contributor attribution in completed-response reports uses the task's assignee.
8. Snapshots store structured JSON; DOCX and PDF are rendered from it on every download, so re-downloads are identical in content.
9. **Owner change (2026-11-09):** Past, Present and Future are chosen from a *Section* dropdown that shows one full-width tree, instead of FR-05's three adjacent panels, to give tasks more room.
