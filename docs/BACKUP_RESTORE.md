# Backup and restore (ProgramAudit only)

Every procedure here touches **only** ProgramAudit's database, volume and
containers (`programaudit-db`, `programaudit_pgdata`, `programaudit_backups`).
None of them stop, restart or read the existing application.

## What must be backed up

All state lives in the ProgramAudit PostgreSQL database: accounts, catalog,
reviews, tasks, every response revision, activity log, and **report snapshots**
(stored as frozen JSON; DOCX and PDF are regenerated from them). There is no
separate file storage.

## Primary method: `pg_dump` (production)

```bash
# Nightly, from the host (cron). Writes into the ProgramAudit-only backup volume.
docker exec programaudit-db sh -c \
  'pg_dump -U programaudit -d programaudit -Fc -f /backups/programaudit-$(date -u +%Y%m%dT%H%MZ).dump'

# Keep 14 daily copies (ProgramAudit volume only)
docker exec programaudit-db sh -c 'ls -1t /backups/programaudit-*.dump | tail -n +15 | xargs -r rm --'

# Copy off-host (e.g. to an S3 bucket the owner designates)
docker cp programaudit-db:/backups/<file>.dump ./ && aws s3 cp <file>.dump s3://<bucket>/programaudit/
```

### Restore drill (isolated, no effect on the live ProgramAudit database)

```bash
docker run -d --name programaudit-restore-test --network none \
  -e POSTGRES_PASSWORD=temp -e POSTGRES_DB=programaudit_restore postgres:17.6-bookworm
docker cp <file>.dump programaudit-restore-test:/tmp/r.dump
docker exec programaudit-restore-test pg_restore -U postgres -d programaudit_restore --no-owner /tmp/r.dump
docker exec programaudit-restore-test psql -U postgres -d programaudit_restore -c \
  "select (select count(*) from response_revisions) revisions, (select count(*) from report_snapshots) snapshots;"
docker rm -f programaudit-restore-test
```

Compare the counts with the live database:
`docker exec programaudit-db psql -U programaudit -d programaudit -c "select count(*) from response_revisions"`.

## Secondary method: application-level JSON backup

A portable, versioned export of every ProgramAudit table except sessions. It
needs no `pg_dump`, so it also works in development.

```bash
npm run backup -- ./programaudit-backup.json      # uses DATABASE_URL
# restore into an EMPTY, migrated ProgramAudit database:
DATABASE_URL=postgres://.../programaudit_restore npm run restore -- ./programaudit-backup.json
```

In production (inside the app container):
`docker exec programaudit-app node server/dist/scripts/backup.js backup /tmp/b.json`.

Safeguards: both commands refuse databases whose name lacks "programaudit".
Restore refuses a target that already contains data, inserts parents before
children, and resets ID sequences afterward.

## Tested restoration (AT-18)

`server/test/backup.test.ts` runs automatically with `npm test`. It:

1. creates data including a moved subtree (child IDs lower than their parents'), two revisions, a completed task and a report snapshot;
2. takes an application-level backup;
3. creates a **separate** database `programaudit_restore_test`, migrates it, and restores;
4. verifies revision text and order, the snapshot content (byte-identical JSON), task completion and parent links, and that sequences continue past restored IDs;
5. confirms that restoring into a non-empty database is refused, then drops the test database.

Result on 2026-11-09: **passed**.
The `pg_dump` restore drill above should be run once on the server after the first authorized deployment and recorded.

## Rollback of a migration

Migrations are reversible (`npm run db:rollback`, or in the container
`node server/dist/scripts/migrate.js rollback`). **Take a `pg_dump` first.**
Rolling back the initial migration drops all ProgramAudit tables.
