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
| `/api/v1/…` | `127.0.0.1:9000` | NestJS (its own global prefix) |
| anything else | — | 404 |

Neither upstream rewrites its path: the prefix the browser asks for is the
prefix the service already routes on.

## Install

```sh
cp eco.conf       /etc/nginx/sites-available/eco
cp eco-proxy.conf /etc/nginx/snippets/eco-proxy.conf
ln -sf /etc/nginx/sites-available/eco /etc/nginx/sites-enabled/eco
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

TLS. This serves plain HTTP; the login page posts a password over it. A
certificate needs a domain pointed at this host, after which certbot or Caddy
would terminate TLS in front of this config.
