# Isolated deployment plan (for owner review)

**Status (2026-11-09): DEPLOYED** at https://programaudit.18-219-232-76.sslip.io
following this plan, with owner authorization. The grading software (Linux
Practical Exam server) passed every before/after check. See
[SERVER_INVENTORY.md](SERVER_INVENTORY.md) for what was found, what was added,
the check results, and the steps still awaiting approval. The plan below is
kept as the reference procedure.

~~Original status: NOT deployed.~~ This plan needs the owner's written
authorization, server access credentials, and a routing decision before any
step in §5 is carried out. Nothing here may stop, restart, reconfigure or
overwrite the existing application at `https://18-219-232-76.sslip.io/`.

## 1. Unknowns that block deployment

| Unknown | Why it matters | Resolved by |
|---|---|---|
| Server OS, CPU, RAM, disk headroom | Resource limits; whether ProgramAudit fits | §2 discovery |
| Existing app's stack (containers? systemd? which proxy?) | Avoid collisions; choose the proxy variant | §2 discovery |
| Occupied ports | ProgramAudit must use an unused loopback port | §2 discovery |
| How TLS certificates are issued | A certificate for a new hostname | §2 discovery + owner |
| ProgramAudit hostname or route | Routing must not touch the existing site | Owner decision (§3) |
| Whether Docker is installed | Installing it is a server change | Discovery + owner |
| SSH access method and account | No credentials are inferred from the IP | Owner |
| Off-host backup destination | Backups must leave the server | Owner |
| Faculty roster / account provisioning / SSO | Production accounts | Owner (spec §14) |
| Report branding | Report title page | Owner (spec §14) |

## 2. Read-only discovery (first authorized session)

These commands only read state. Record the output in `docs/server-inventory.md`
(created at that time and kept out of git if it contains anything sensitive).
Skip any command the operator account may not run, and note it.

```bash
# Host and headroom
uname -a; cat /etc/os-release; nproc; free -m; df -h; uptime
# Running services and listeners
systemctl list-units --type=service --state=running --no-pager
sudo ss -tlnp
# Containers (if Docker is present)
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker network ls; docker volume ls; docker compose ls
docker stats --no-stream
# Reverse proxy and certificates (whichever exists)
sudo nginx -T 2>/dev/null | grep -E 'server_name|listen|proxy_pass|root'
sudo caddy list-modules >/dev/null 2>&1 && sudo cat /etc/caddy/Caddyfile
sudo certbot certificates 2>/dev/null
# Scheduled jobs that could interact (e.g. backups, cleanup scripts)
sudo crontab -l; ls /etc/cron.d
# AWS security group: check in the console which inbound ports are open (read only).
```

### Baseline health of the existing application (record before AND after)

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w '%{http_code} %{time_total}s %{size_download}B\n' https://18-219-232-76.sslip.io/
done
curl -sI https://18-219-232-76.sslip.io/ | grep -iE '^(HTTP|server|content-type)'
echo | openssl s_client -connect 18-219-232-76.sslip.io:443 -servername 18-219-232-76.sslip.io 2>/dev/null | openssl x509 -noout -dates -subject
```

Also record the existing app's container or service status, its memory/CPU
from `docker stats`/`top`, and any health URL or page the owner names as a
functional check (e.g. sign-in page loads).

**Stop conditions:** halt and report the specific conflict if any of these hold:
- less than ~1 GB of free RAM or ~5 GB of free disk after ProgramAudit's limits;
- no unused port, or the proxy cannot add a new hostname without editing the existing site's block;
- Docker is absent and installing it is not approved;
- the existing app shares a PostgreSQL instance and a separate database cannot be created without touching it.

Local development continues regardless.

## 3. Routing options (owner decides)

| Option | Effect on existing app | Notes |
|---|---|---|
| **A. Separate hostname via existing proxy** (recommended), e.g. `programaudit.18-219-232-76.sslip.io` or an institutional subdomain | A **new** site block plus a proxy *reload* (not restart); the existing block is untouched | Needs a certificate for the new name. sslip.io wildcard DNS already resolves subdomains to this IP. |
| B. Separate ProgramAudit proxy on another public port (e.g. 8443) | None on the existing proxy | Needs a security-group change and an unusual URL. |
| C. Path prefix on the existing hostname (`/programaudit`) | **Edits the existing site's config.** | Not recommended; the SPA would also need base-path changes. |

Proxy snippets for A are in [`deploy/proxy-examples.md`](../deploy/proxy-examples.md).

## 4. Isolation design

| Resource | ProgramAudit value | Separation from existing app |
|---|---|---|
| Directory | `/opt/programaudit` (code checkout + `deploy/.env.production`, mode 600) | New directory; nothing written elsewhere except the new proxy site file |
| Compose project | `programaudit` (`-p programaudit`) | Distinct project name, so `docker compose down` can't touch other stacks |
| Containers | `programaudit-app`, `programaudit-db` | Prefixed names |
| Networks | `programaudit_internal` (internal-only), `programaudit_edge` | The DB is only on the internal network |
| Volumes | `programaudit_pgdata`, `programaudit_backups` | Prefixed names |
| Database | Own PostgreSQL container, database `programaudit`, role `programaudit` | No shared DB server, credentials or migrations |
| Ports | App: `127.0.0.1:<PROGRAMAUDIT_HOST_PORT>` only. DB: **none published** | Port chosen from the §2 inventory; never 80/443 |
| Secrets | `deploy/.env.production` (not in git) | Separate random DB password and session secret |
| Logs | Docker json-file, 10 MB × 5 per container | Bounded disk use |
| Resource limits | App: 1 CPU / 512 MB. DB: 0.5 CPU / 512 MB | Caps ProgramAudit's impact; adjust to measured headroom |
| TLS | Certificate for the new hostname only | The existing certificate is untouched |

`deploy/docker-compose.yml` implements this table.

## 5. Deployment steps (only after authorization)

1. Complete §2. Confirm the stop conditions are clear. Record the baseline.
2. `sudo mkdir /opt/programaudit && sudo chown <deploy-user> /opt/programaudit`, then clone the repository there.
3. `cd /opt/programaudit/deploy && cp .env.production.example .env.production && chmod 600 .env.production`, and fill in the chosen port, origin and random secrets.
4. Build: `docker compose -p programaudit --env-file .env.production build`.
5. Start the database: `docker compose -p programaudit --env-file .env.production up -d programaudit-db`.
6. Migrate: `docker compose -p programaudit --env-file .env.production run --rm programaudit-app node server/dist/scripts/migrate.js latest`.
7. Start the app: `docker compose -p programaudit --env-file .env.production up -d programaudit-app`.
8. Local check: `curl -s http://127.0.0.1:$PORT/api/health` should return `{"status":"ok","database":"ok"}`.
9. Create the first administrator (the dev seed script refuses production by design):
   `docker compose -p programaudit --env-file .env.production run --rm -e ADMIN_PASSWORD='<approved>' programaudit-app node server/dist/scripts/create-admin.js <email> "<Name>"`
10. Add the **new** proxy site (§3 A), validate it (`nginx -t` / `caddy validate`), and *reload* the proxy. Issue the certificate for the new hostname.
11. Run the after-checks (§6). If any existing-app check differs from the baseline, roll back immediately (§7).
12. Install the nightly backup cron entry from [BACKUP_RESTORE.md](BACKUP_RESTORE.md) and run one restore drill.

## 6. Before-and-after checks (AT-19)

| Check | Before | After |
|---|---|---|
| Existing app `curl` status, time, size (×3) | record | same status; similar time |
| Existing app TLS certificate subject and dates | record | unchanged |
| Existing app containers/services running and their restart counts | record | unchanged; no restarts |
| Existing proxy site config checksum (`sha256sum` of its file) | record | **unchanged** |
| Listening ports (`ss -tlnp`) | record | only the new `127.0.0.1:<port>` added |
| `docker ps` / `docker volume ls` / `docker network ls` | record | only `programaudit*` items added |
| Free RAM / disk | record | within limits |
| ProgramAudit `/api/health` via the new hostname | — | `ok` |
| ProgramAudit sign-in, review load, save, report download | — | works |
| DB port not reachable from outside (`nc -vz 18.219.232.76 5432` from off-host) | — | refused / filtered |

## 7. Rollback (affects ProgramAudit only)

```bash
# 1. Remove ProgramAudit's proxy site, validate, reload (existing site untouched)
sudo rm /etc/nginx/sites-enabled/programaudit.conf && sudo nginx -t && sudo systemctl reload nginx
# 2. Stop ProgramAudit containers (project-scoped; data volumes kept)
cd /opt/programaudit/deploy && docker compose -p programaudit --env-file .env.production down
# 3. Optional, only if explicitly approved: remove data (take a pg_dump first)
# docker volume rm programaudit_pgdata programaudit_backups
```

To roll back to a previous ProgramAudit version instead: check out the earlier
tag, rebuild, and `up -d programaudit-app`. Restore the pre-upgrade `pg_dump`
first if that release's migrations are older.

After rollback, repeat the §6 existing-app checks.

## 8. Future updates

`git pull` → `docker compose -p programaudit build` → `pg_dump` →
`run --rm programaudit-app node server/dist/scripts/migrate.js latest` →
`up -d programaudit-app` → §6 checks.
