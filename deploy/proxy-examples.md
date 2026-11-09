# Reverse-proxy examples (adapt only after discovery and owner approval)

These are **examples**, not instructions to edit the server. The existing
application's proxy (nginx, Caddy, Traefik, or none) has not been identified.
Choose the variant that matches what discovery finds, and add ProgramAudit as a
**new, separate site/hostname**. Never edit the existing app's server block.

Replace `programaudit.example.edu` with the approved hostname and `PORT` with
`PROGRAMAUDIT_HOST_PORT`.

## nginx (new file, e.g. `/etc/nginx/sites-available/programaudit.conf`)

```nginx
server {
    listen 443 ssl http2;
    server_name programaudit.example.edu;

    ssl_certificate     /etc/letsencrypt/live/programaudit.example.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/programaudit.example.edu/privkey.pem;

    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:PORT;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
server {
    listen 80;
    server_name programaudit.example.edu;
    return 301 https://$host$request_uri;
}
```

Validate with `sudo nginx -t` and apply with `sudo systemctl reload nginx`
(a reload, not a restart, keeps existing connections). Obtain the certificate
for the new hostname only, e.g. `sudo certbot certonly --nginx -d programaudit.example.edu`.

## Caddy (append a new site block)

```caddy
programaudit.example.edu {
    reverse_proxy 127.0.0.1:PORT
    request_body {
        max_size 4MB
    }
}
```

Validate with `caddy validate --config /etc/caddy/Caddyfile` and apply with
`sudo systemctl reload caddy`.

## sslip.io hostnames

The existing app uses `18-219-232-76.sslip.io`. A separate wildcard-DNS name
such as `programaudit.18-219-232-76.sslip.io` resolves to the same IP and
lets the proxy route by hostname without touching the existing site. This is
an option to present to the owner, not an assumed decision.
