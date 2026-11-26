#!/usr/bin/env bash
# Read-only checks for an already running staging stack.
set -euo pipefail
origin=${1:?Supply the staging HTTPS origin}
[[ $origin == https://* && $origin != */ ]]
tmp=$(mktemp -d)
trap 'rm -f "$tmp/home" "$tmp/deep" "$tmp/api" "$tmp/csrf"; rmdir "$tmp"' EXIT
curl --fail --silent --show-error --max-time 15 "$origin/" > "$tmp/home"
curl --fail --silent --show-error --max-time 15 "$origin/journal/00000000-0000-4000-8000-000000000001" > "$tmp/deep"
grep -q 'id="root"' "$tmp/home"
cmp "$tmp/home" "$tmp/deep"
curl --fail --silent --show-error --max-time 15 "$origin/api/health" | grep -Fq '{"status":"ok"}'
code=$(curl --silent --show-error --max-time 15 --output "$tmp/api" --write-out '%{http_code}' "$origin/api/entries")
[[ $code == 401 ]]
grep -Fq '"detail"' "$tmp/api"
code=$(curl --silent --show-error --max-time 15 --output "$tmp/csrf" --write-out '%{http_code}' \
  -H "Origin: $origin" -H 'Content-Type: application/json' -d '{}' "$origin/api/entries")
[[ $code == 403 ]]
printf '%s\n' 'HTTPS, React deep links, API routing, and request protections passed.'
