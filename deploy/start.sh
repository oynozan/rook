#!/usr/bin/env bash
# The container's two processes: the services (pnpm live: every service on 127.0.0.1:7889-7894, role keys from
# $ROOK_ENV_FILE, each key handed only to the service that uses it) and the web app on 0.0.0.0:$WEB_PORT, whose
# secrets Next.js reads from web/.env.production.local. If either exits, both stop and Docker restarts the container.
set -u
cd /app
for f in "$ROOK_ENV_FILE" web/.env.production.local; do
  [ -s "$f" ] || { echo "missing $f: create deploy/services.env and deploy/web.env (docs/operations.md, Deploy)"; exit 1; }
done

pnpm live &
(cd web && exec node_modules/.bin/next start -p "$WEB_PORT" -H 0.0.0.0) &

trap 'kill $(jobs -p) 2>/dev/null; wait; exit 0' TERM INT
wait -n
code=$?
kill $(jobs -p) 2>/dev/null
wait
exit "$code"
