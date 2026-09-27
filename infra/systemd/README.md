# systemd — the API and web server as supervised services

The two Node processes that serve the app run as systemd units on the VM:
`eco-api` on `:9000` and `eco-web` on `:3000`, both bound to loopback, with a
shared Caddy gateway in front of them.

They were started by hand from a shell until 2026-09-22, when an unattended
kernel upgrade rebooted the machine. Every container came back on its own
restart policy; these two did not, so the edge kept answering and returned 502
for a day. The units are `enabled`, so both start at boot, and
`Restart=always`, so both come back from a crash.

## Installing them

These files are the copy of record. The live ones are in
`/etc/systemd/system/`, which is not in this repository:

```bash
sudo cp infra/systemd/eco-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eco-api eco-web
```

Keep the two in step — edit here, copy, `daemon-reload`.

## Two details worth not breaking

- **`WorkingDirectory` on `eco-api` is load-bearing.** The API reads its
  configuration from `./.env`, a symlink to the repository root's `.env`,
  resolved against that directory. Started anywhere else it comes up with no
  `DATABASE_URL` and refuses to boot.
- **`eco-web` sets `HOSTNAME=127.0.0.1`.** Next binds every interface
  otherwise, and `ufw` is inactive on this machine, so that would publish the
  app directly rather than through the edge.

Deploys go through [`scripts/redeploy.sh`](../../scripts/redeploy.sh), which
builds and then restarts the unit; it does not manage processes itself.
