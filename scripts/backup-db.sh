#!/usr/bin/env bash
#
# Dump the Eco database to a local, restorable archive.
#
# Everything durable is in Postgres: there are no uploads (reports render in
# memory) and Redis holds only cache, sessions and rate-limit counters, all of
# which regenerate. So one dump of `eco` is the whole backup.
#
# Two things this deliberately does NOT do:
#
#   1. It does not copy .env. Some columns — 2FA secrets today — are AES-256-GCM
#      encrypted with ENCRYPTION_KEY, so a dump stored next to the key is a dump
#      with no encryption at all. Keep the key somewhere else; a restore without
#      it recovers everything except those columns.
#   2. It does not ship the archive off this machine. A backup that only exists
#      on the host it backs up survives a bad migration but not a dead disk.
#      Point ECO_BACKUP_DIR at mounted off-host storage, or add an upload step.
#
# Usage: scripts/backup-db.sh [--verify]
#          --verify  additionally restore the fresh dump into a scratch database
#                    and drop it, proving the archive is actually restorable.
#
# Env: ECO_BACKUP_DIR    where archives live      (default /var/backups/eco)
#      ECO_BACKUP_KEEP   archives to retain       (default 12)
#      ECO_PG_CONTAINER  Postgres container name  (default eco-postgres)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${ECO_BACKUP_DIR:-/var/backups/eco}"
KEEP="${ECO_BACKUP_KEEP:-12}"
CONTAINER="${ECO_PG_CONTAINER:-eco-postgres}"
VERIFY=0
[[ "${1:-}" == "--verify" ]] && VERIFY=1

# Credentials come from .env so this stays correct when they are rotated.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . <(grep -E '^POSTGRES_(USER|PASSWORD|DB)=' "$ROOT/.env")
  set +a
fi
PG_USER="${POSTGRES_USER:-eco}"
PG_DB="${POSTGRES_DB:-eco}"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "FAILED: $*" >&2; exit 1; }

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true \
  || die "container '$CONTAINER' is not running — nothing was backed up"

# 0700/0600 throughout: these archives are every user's salary, debts and
# merchant history in plain text.
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u '+%Y-%m-%dT%H%M%SZ')"
ARCHIVE="$BACKUP_DIR/eco-$STAMP.dump"
PART="$ARCHIVE.part"
trap 'rm -f "$PART"' EXIT

# Custom format (-Fc): compressed, and restorable selectively — a single table
# can be pulled back without replaying the whole dump. Writing to .part and
# renaming means an interrupted run never leaves a half-file that looks valid
# to the retention sweep below.
log "dumping $PG_DB from $CONTAINER"
umask 077
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -Z 6 > "$PART" \
  || die "pg_dump exited non-zero"

[[ -s "$PART" ]] || die "dump is empty"

# A dump that pg_restore cannot even read its own table of contents from is not
# a backup. This is cheap; run it every time.
docker exec -i "$CONTAINER" pg_restore --list < "$PART" > /dev/null \
  || die "dump did not survive a pg_restore --list — treating it as corrupt"

mv "$PART" "$ARCHIVE"
chmod 600 "$ARCHIVE"
trap - EXIT
log "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

if [[ "$VERIFY" -eq 1 ]]; then
  SCRATCH="eco_restore_check_$$"
  log "restoring into scratch database $SCRATCH"
  cleanup_scratch() {
    docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
      dropdb -U "$PG_USER" --if-exists "$SCRATCH" >/dev/null 2>&1 || true
  }
  trap cleanup_scratch EXIT
  docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    createdb -U "$PG_USER" "$SCRATCH" || die "could not create scratch database"
  # --no-owner: roles differ between here and any machine restoring this later.
  docker exec -i -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    pg_restore -U "$PG_USER" -d "$SCRATCH" --no-owner --no-privileges \
    < "$ARCHIVE" > /dev/null || die "restore into scratch database failed"
  TABLES="$(docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    psql -U "$PG_USER" -d "$SCRATCH" -tAc \
    "select count(*) from information_schema.tables where table_schema='public'")"
  USERS="$(docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    psql -U "$PG_USER" -d "$SCRATCH" -tAc 'select count(*) from users' 2>/dev/null || echo '?')"
  cleanup_scratch
  trap - EXIT
  [[ "$TABLES" -gt 0 ]] || die "restored database has no tables"
  log "verified: restored $TABLES tables, $USERS users"
fi

# Retention. Sorted by name, which sorts by time because the stamp is ISO-8601
# UTC. Only complete archives match the glob — .part files never do.
mapfile -t OLD < <(ls -1 "$BACKUP_DIR"/eco-*.dump 2>/dev/null | sort | head -n -"$KEEP")
if [[ ${#OLD[@]} -gt 0 ]]; then
  rm -f "${OLD[@]}"
  log "pruned ${#OLD[@]} archive(s) beyond the $KEEP most recent"
fi

log "done — $(ls -1 "$BACKUP_DIR"/eco-*.dump | wc -l) archive(s) in $BACKUP_DIR"
