#!/usr/bin/env bash
# Run on a disposable Linux CI runner with Docker and local ports 80/443 free.
set -euo pipefail
export STAGING_CONFIG_DIR
STAGING_CONFIG_DIR=$(mktemp -d)
export RELEASE_SHA STAGING_HOST=localhost
RELEASE_SHA=$(git rev-parse HEAD)
compose() { docker compose -f deploy/staging/compose.yaml "$@"; }
cleanup() {
  local status=$?
  if (( status != 0 )); then
    compose logs --no-color --tail=80 db api web || true
  fi
  compose down --volumes
}
trap cleanup EXIT

mkdir "$STAGING_CONFIG_DIR/tls"
cd "$STAGING_CONFIG_DIR/tls"
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=AuraJournal-CI-CA -keyout ca.key -out ca.crt
openssl req -new -newkey rsa:2048 -noenc -subj /CN=db -keyout db.key -out db.csr
printf 'subjectAltName=DNS:db\nextendedKeyUsage=serverAuth\n' > db.ext
openssl x509 -req -days 1 -in db.csr -CA ca.crt -CAkey ca.key -CAcreateserial -extfile db.ext -out db.crt
chmod 644 ca.crt db.crt
db_uid=$(docker run --rm --entrypoint id postgres:17-bookworm -u postgres)
sudo chown "$db_uid" db.key
sudo chmod 600 db.key
cd - >/dev/null

printf '%s\n' 'ci-only-bootstrap-password' > "$STAGING_CONFIG_DIR/postgres-admin"
printf '%s\n' 'DATABASE_URL=postgresql+psycopg://aurajournal_runtime:ci-only-runtime-password@db:5432/aurajournal?sslmode=verify-full&sslrootcert=/db-ca/ca.crt' > "$STAGING_CONFIG_DIR/api.env"
printf '%s\n' 'MIGRATION_DATABASE_URL=postgresql+psycopg://aurajournal_owner:ci-only-owner-password@db:5432/aurajournal?sslmode=verify-full&sslrootcert=/db-ca/ca.crt' > "$STAGING_CONFIG_DIR/migrate.env"
chmod 600 "$STAGING_CONFIG_DIR/"{postgres-admin,api.env,migrate.env}

compose --profile ops config --quiet
compose build api web
compose run --rm --no-deps web caddy validate --config /etc/caddy/Caddyfile
compose up -d --wait db
compose exec -T -u postgres db psql -X -v ON_ERROR_STOP=1 -d aurajournal <<'SQL'
ALTER ROLE aurajournal_owner PASSWORD 'ci-only-owner-password';
ALTER ROLE aurajournal_runtime PASSWORD 'ci-only-runtime-password';
SQL
compose run --rm migrate
compose exec -T -u postgres db psql -X -d aurajournal -f - < scripts/database-runtime-role.sql
compose up -d --no-build --wait api web
# Compose reports Caddy running before it has finished creating the local CA.
for attempt in {1..15}; do
  if compose exec -T web test -s /data/caddy/pki/authorities/local/root.crt; then
    break
  fi
  sleep 1
done
compose cp web:/data/caddy/pki/authorities/local/root.crt "$STAGING_CONFIG_DIR/caddy-ca.crt"
CURL_CA_BUNDLE="$STAGING_CONFIG_DIR/caddy-ca.crt" bash deploy/staging/check-https.sh https://localhost

request() {
  curl --fail --silent --show-error --max-time 15 --cacert "$STAGING_CONFIG_DIR/caddy-ca.crt" \
    -H 'Origin: https://localhost' -H 'Content-Type: application/json' -H 'X-AuraJournal-CSRF: 1' "$@"
}
cookies="$STAGING_CONFIG_DIR/session.cookies"
account='{"email":"staging-ci@example.com","password":"fictional-container-test-password"}'
request -c "$cookies" -d "$account" https://localhost/api/auth/register >/dev/null
request -b "$cookies" -c "$cookies" -d '{}' https://localhost/api/auth/logout
request -c "$cookies" -d "$account" https://localhost/api/auth/login >/dev/null
entry=$(request -b "$cookies" -d '{"content":"Container persistence check."}' https://localhost/api/entries)
entry_id=$(python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])' <<< "$entry")
compose restart api
compose up -d --no-build --wait api web
saved=$(request -b "$cookies" "https://localhost/api/entries/$entry_id")
[[ $entry == "$saved" ]]
printf '%s\n' 'HTTPS login and journal persistence after API restart passed.'
