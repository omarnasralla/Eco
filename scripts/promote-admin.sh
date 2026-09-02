#!/usr/bin/env bash
# Grants ADMIN to an existing account.
#
# There is no way to create the first administrator through the app: the admin
# routes require ADMIN, so a deployment with none cannot bootstrap one. That is
# deliberate — self-service promotion would be a privilege-escalation hole — so
# the first one is granted here, with database access as the proof of authority.
#
#   ./scripts/promote-admin.sh you@example.com
#
# The Redis delete matters: the JWT strategy caches the authenticated user for
# 60 seconds, so without it the new role does not take effect until that lapses.
set -euo pipefail

EMAIL="${1:?usage: promote-admin.sh <email>}"
PG="${PG_CONTAINER:-eco-postgres}"
REDIS="${REDIS_CONTAINER:-eco-redis}"

ID=$(docker exec "$PG" psql -U eco -d eco -tAc \
  "SELECT id FROM users WHERE email='${EMAIL}' AND \"deletedAt\" IS NULL;")

if [ -z "$ID" ]; then
  echo "No active account with email ${EMAIL}" >&2
  exit 1
fi

docker exec "$PG" psql -U eco -d eco -tAc "UPDATE users SET role='ADMIN' WHERE id='${ID}';" >/dev/null
docker exec "$REDIS" redis-cli DEL "auth:user:${ID}" >/dev/null

echo "${EMAIL} is now an ADMIN. Sign out and back in to refresh the session."
