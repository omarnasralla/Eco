# nginx — single public entry point

The app and the API used to be published on separate ports, which meant two
ports open to the internet, two origins for the browser to reconcile, and a
CORS allowlist that had to be edited whenever either address moved. nginx
fronts both on `:80`, so everything the browser touches is one origin.

## Routes

| Path | Upstream | |
|---|---|---|
| `/` | — | 302 to `/eco/app` |
| `/eco/app…` | `127.0.0.1:3000` | Next.js (its `basePath`) |
| `/eco/api/v1/…` | `127.0.0.1:9000` | NestJS (its own global prefix) |
| anything else | — | 404 |

Neither upstream rewrites its path: the prefix the browser asks for is the
prefix the service already routes on.

## Hostnames

Served for `bg.work.gd` and for the bare IP, so a DNS change cannot lock
anyone out mid-flight. Anything else on :80 hits `eco-default.conf` and gets
444 — without a `default_server`, nginx hands the first block to any Host
header at all, including a scanner probing the IP.

Adding a hostname needs **no rebuild**: `NEXT_PUBLIC_API_URL` is relative, so
the bundle asks whatever host the page was served from. Add the name to
`server_name` here and to `CORS_ORIGINS` in `.env`, then reload.

## Install

```sh
cp eco.conf         /etc/nginx/sites-available/eco
cp eco-default.conf /etc/nginx/sites-available/eco-default
cp eco-proxy.conf /etc/nginx/snippets/eco-proxy.conf
ln -sf /etc/nginx/sites-available/eco         /etc/nginx/sites-enabled/eco
ln -sf /etc/nginx/sites-available/eco-default /etc/nginx/sites-enabled/eco-default
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx && systemctl enable nginx
```

## What must stay true

- **Every upstream binds the loopback.** `API_HOST=127.0.0.1` in `.env`, Next
  started with `-H 127.0.0.1`, uvicorn with `--host 127.0.0.1`, and every
  `ports:` entry in `docker-compose.yml` prefixed `127.0.0.1:`. Without that
  the direct ports stay open and the proxy is decoration. Docker publishes to
  `0.0.0.0` by default and does not warn.
- **`NEXT_PUBLIC_API_URL` is relative** (`/api/v1`). One origin means the
  browser can ask its own host, which keeps the deployment's address out of the
  JS bundle — the same build then serves an IP, a domain, or HTTPS unchanged.
- **`proxy_read_timeout` on the API is 180s.** The assistant runs a 3B model on
  CPU and answers in ~36s with no streaming, so nginx's 60s default would cut
  it off mid-reply.

## Not done here

TLS. This serves plain HTTP; the login page posts a password over it.

`WEB_ORIGIN` is set to `https://bg.work.gd/eco/app`, so every link this
deployment emails or hands to an administrator already carries that address.
Two things have to be true before those links resolve, and neither can be done
from this machine alone:

1. **DNS.** `bg.work.gd` currently resolves to `81.208.190.196`; this host is
   `169.58.227.114`. The A record has to point here. `server_name` already
   lists the domain, so plain HTTP works the moment it does.
2. **A certificate.** With DNS pointing here:

   ```
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d bg.work.gd
   ```

   certbot adds the 443 server block and the redirect to this config, and
   installs a renewal timer. Until then the URLs are correct and unreachable —
   a deliberate trade, made so nothing has to be rewritten later.

Until DNS is repointed, an administrator issuing a password reset should expect
the link not to open, and reset links cannot be handed to anyone.
