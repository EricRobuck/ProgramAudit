# Server inventory and deployment record — 2026-11-09

Host `ip-172-31-34-167` (18.219.232.76): Ubuntu 24.04.4 LTS, 2 vCPU, 3.8 GB RAM
(+4 GB swap), 29 GB disk. Docker 29.9.0 (cgroup v2), Docker Compose v5.6.0.

## Existing application (grading software): left untouched

| Item | Value |
|---|---|
| Name | Linux Practical Exam server (`linuxlab.service`, user `linuxlab`) |
| Code / data | `/opt/linuxlab` |
| Listener | `127.0.0.1:3001` (API + websocket), static UI from `/opt/linuxlab/apps/web/dist` |
| Public site | `https://18-219-232-76.sslip.io` via Caddy (`/etc/caddy/Caddyfile`) |
| Docker use | Starts student containers from `linuxlab/student-ubuntu:24.04`, labelled `linuxlab.managed`, `NetworkMode: none`, 256 MB / 0.5 CPU each, up to 50 at once. It lists and removes **only** containers carrying its own label. |

## ProgramAudit footprint (everything added)

| Item | Value |
|---|---|
| Directory | `/opt/programaudit` (git checkout; `deploy/.env.production`, mode 600) |
| Containers | `programaudit-app` (image `programaudit:0.1.0`), `programaudit-db` (`postgres:17.6-bookworm`) |
| Networks | `programaudit_programaudit_internal` (internal), `programaudit_programaudit_edge` |
| Volumes | `programaudit_programaudit_pgdata`, `programaudit_programaudit_backups` |
| Port | `127.0.0.1:4100` only; database publishes no port |
| Limits | app 384 MB / 0.75 CPU; db 256 MB / 0.5 CPU; `cpu_shares` 256 (low priority); `oom_score_adj` 500 (stopped first under memory pressure) |
| Caddy | New site block for `programaudit.18-219-232-76.sslip.io` **appended** to `/etc/caddy/Caddyfile`; the original content is byte-identical (sha256 `62c0de89…7760`). Backup of the pre-change file: `/etc/caddy/Caddyfile.bak-before-programaudit`. Applied with `systemctl reload` (no restart). |
| TLS | Let's Encrypt certificate for `programaudit.18-219-232-76.sslip.io`, issued automatically by Caddy |
| URL | https://programaudit.18-219-232-76.sslip.io |

## Before / after checks (AT-19)

| Check | Before | After |
|---|---|---|
| Grading site (from server, ×3) | 200, 0.16 / 0.023 / 0.023 s, 405 B | 200, 0.16 / 0.023 / 0.023 s, 405 B |
| Grading site certificate | CN 18-219-232-76.sslip.io, valid to 2027-01-12 | unchanged |
| `127.0.0.1:3001/` | 302 | 302 |
| `linuxlab.service` | active, PID 1138, 0 restarts, started 2026-11-04 | identical |
| `caddy.service` | active, PID 580, 0 restarts | identical (reloaded in place) |
| Listeners | 22, 53, 80, 443, 2019, 3001 | same + `127.0.0.1:4100` |
| Docker containers/networks/volumes | none besides defaults | only `programaudit*` added |
| Free memory (available) | 3,046 MB | 2,837 MB (ProgramAudit uses ≈ 76 MB at idle) |
| Disk used | 8.6 GB | 11 GB (image + build cache) |
| Ports 4100 and 5432 from the internet | — | closed |
| Backup + isolated restore drill | — | passed (`/backups/programaudit-initial.dump`) |

## Not done (needs owner approval)

- **Nightly backup schedule.** A cron entry (`/etc/cron.d/programaudit`) was not installed: adding a persistent scheduled job was held for explicit approval. The proposed entry is in [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
- **Off-server backup copies.** No destination has been chosen.

## Operating commands

```bash
cd /opt/programaudit/deploy
C="sudo docker compose -p programaudit --env-file .env.production"
$C ps                     # status
$C logs --tail 100 programaudit-app
# update: git -C /opt/programaudit pull && $C build programaudit-app && <pg_dump> && \
#         $C run --rm -T programaudit-app node server/dist/scripts/migrate.js latest </dev/null && $C up -d programaudit-app
# reset a password:
$C run --rm -T -e NEW_PASSWORD='…' programaudit-app node server/dist/scripts/set-password.js <email> </dev/null
```

Note: always pass `-T` and `</dev/null` to `docker compose run` inside scripts; otherwise it consumes the script's remaining standard input.

## Rollback (ProgramAudit only)

1. `sudo cp /etc/caddy/Caddyfile.bak-before-programaudit /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`
2. `cd /opt/programaudit/deploy && sudo docker compose -p programaudit --env-file .env.production down` (keeps data volumes)
