# Shared HTTPS staging

Teammates open the staging HTTPS URL supplied by the operator, create their own
account or log in, and save a fictional journal. Open History and refresh to
check that it persists. In Weekly Reflection, select a seven-day range that
includes the journal and generate a reflection. The Record page can send a short
fictional WebM/Opus recording to Deepgram. Use fictional content on staging.

## First deploy

Use a dedicated Linux host with Docker Compose v2, OpenSSL, Git and curl. Point
the staging DNS record to the host, remove stale IPv6 records, and allow inbound
TCP 80/443 for Caddy and certificate issuance. The API and PostgreSQL ports stay
inside Compose. Restrict SSH to operators. Run commands from the checkout root.

1. Create a protected host directory such as `/etc/aurajournal/staging` owned by
   the deploy operator and set its mode to `0700`. Keep it outside the checkout.
   Copy `deploy/staging/.env.example` to the ignored `deploy/staging/.env`.
   Set `STAGING_HOST` to the DNS name, `STAGING_CONFIG_DIR` to the protected
   directory, and `RELEASE_SHA` to the full SHA of the clean checkout being built.
   If `172.29.51.0/24` overlaps a host network, set both `EDGE_SUBNET` and
   `CADDY_IP` to a free subnet and an address within it.
2. In the protected directory, create `postgres-admin` with one random bootstrap
   password and mode `0600`. Under `tls/`, create `ca.crt`, `db.crt`, and
   `db.key` with a staging-only CA and a server certificate whose SAN is
   `DNS:db`. The following commands illustrate issuance from that directory.

   ```sh
   umask 077
   mkdir -p tls
   cd tls
   openssl req -x509 -newkey rsa:3072 -noenc -days 365 -subj /CN=AuraJournal-Staging-CA -keyout ca.key -out ca.crt
   openssl req -new -newkey rsa:3072 -noenc -subj /CN=db -keyout db.key -out db.csr
   printf 'subjectAltName=DNS:db\nextendedKeyUsage=serverAuth\n' > db.ext
   openssl x509 -req -in db.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 90 -extfile db.ext -out db.crt
   chmod 644 ca.crt db.crt
   db_uid=$(docker run --rm --entrypoint id postgres:17-bookworm -u postgres)
   sudo chown "$db_uid" db.key
   sudo chmod 600 db.key
   ```

   Store the CA signing key securely offline after issuance. Track expiry and
   renew before certificates expire. Return to the checkout root.

3. In the protected directory, create separate `api.env` and `migrate.env`
   with mode `0600`. Replace the password placeholders with distinct random
   passwords. Percent-encode any reserved URL characters. Put staging provider
   keys in `api.env` alongside the runtime URL. Supply the actual role passwords
   through psql's interactive prompts in step 4.

   ```dotenv
   # api.env
   DATABASE_URL=postgresql+psycopg://aurajournal_runtime:<RUNTIME_PASSWORD>@db:5432/aurajournal?sslmode=verify-full&sslrootcert=/db-ca/ca.crt
   GROQ_API_KEY=
   DEEPGRAM_API_KEY=
   # GROQ_MODEL=your-configured-model
   ```

   ```dotenv
   # migrate.env
   MIGRATION_DATABASE_URL=postgresql+psycopg://aurajournal_owner:<OWNER_PASSWORD>@db:5432/aurajournal?sslmode=verify-full&sslrootcert=/db-ca/ca.crt
   ```

4. Build, initialize PostgreSQL, and set role passwords. The role initializer
   runs on a fresh DB volume. Type the two `\password` commands inside psql.

   ```sh
   stage() { docker compose --env-file deploy/staging/.env -f deploy/staging/compose.yaml "$@"; }
   stage --profile ops config --quiet
   stage build api web
   stage run --rm --no-deps web caddy validate --config /etc/caddy/Caddyfile
   stage up -d --wait db
   stage exec -u postgres db psql -X -d aurajournal
   ```

   ```text
   \password aurajournal_owner
   \password aurajournal_runtime
   \q
   ```

   ```sh
   stage run --rm migrate
   stage run --rm migrate python -m alembic current
   stage exec -T -u postgres db psql -X -d aurajournal -f - < scripts/database-runtime-role.sql
   stage up -d --no-build --wait api web
   bash deploy/staging/check-https.sh "https://YOUR_STAGING_HOST"
   ```

   The Alembic output must show the checkout's head. The app uses the same
   origin for the browser and API, secure cookies, and its existing Origin and
   CSRF checks. The migration credentials are available only to the one-shot
   migration container. PixelLab is disabled in this staging configuration.

## Verify the release

Run the normal scenario from an operator workstation with backend requirements
installed, using a short fictional speech recording. Record the commit, URL,
Alembic revision, timestamp, and pass/fail results. The smoke runner creates and
cleans up its own account and checks live Groq and Deepgram responses.

```sh
python scripts/smoke-api.py --api-url "https://YOUR_STAGING_HOST" \
  --origin "https://YOUR_STAGING_HOST" --audio fictional-speech.webm
```

From a browser on another machine, create a disposable account, log out and back
in, create a journal, and generate a weekly reflection. Refresh the page.
Restart the API with `stage restart api`, wait for `stage up -d --no-build --wait api web`,
then log in again and confirm both records survived. Check another disposable
account cannot open the first journal and remove both test accounts afterward.
Record this separately from the automated tests.

## Redeploy and roll back

1. Record the currently deployed SHA and schema revision. Back up before a
   migration, using a directory outside the checkout with mode `0700`.
   Keep the database roles and the private image volume with the release backup.
   For a database-only staging backup on this host, run the following.

   ```sh
   umask 077
   stage exec -T -u postgres db pg_dump -Fc -d aurajournal > /path/to/protected/backup.dump
   stage exec -T -u postgres db pg_restore --list < /path/to/protected/backup.dump
   ```

   Verify restoration to a fresh scratch database before relying on the backup.
   Compare the restored revision and journal count to the source backup records.

   ```sh
   stage exec -T -u postgres db createdb -O aurajournal_owner aurajournal_restore_check
   stage exec -T -u postgres db pg_restore --single-transaction --exit-on-error -d aurajournal_restore_check < /path/to/protected/backup.dump
   stage exec -T -u postgres db psql -X -d aurajournal_restore_check -c 'SELECT version_num FROM alembic_version' -c 'SELECT count(*) FROM journal_entries'
   ```

   Clean up the scratch database after verification.
2. Check out the desired commit, update `RELEASE_SHA`, validate and build both
   images, and keep the previous tags. Stop the API before a schema upgrade.
   Run the migration and check its revision. Apply explicit runtime grants
   for any new tables introduced by that release. Start the new images with
   `stage up -d --no-build --wait api web` and repeat verification.
3. For rollback with a compatible schema, use the previous checkout and SHA,
   then start the previous tags with `stage up -d --no-build --wait api web`.
   If the schema is incompatible, stop serving traffic, preserve a new backup
   of the failed release, and restore the verified prior backup and matching
   image data before starting the previous release. With the API stopped, the
   operator can rename the failed `aurajournal` database from the `postgres`
   maintenance database, create a fresh `aurajournal` owned by
   `aurajournal_owner`, and use the same `pg_restore` command against it. Reapply
   the runtime grants from the previous checkout. This loses access in the
   restored release to writes made since the backup. Test the restored release
   before reopening it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No certificate or TLS warning | Confirm DNS to this host, port 80/443 reachability, and Caddy logs. |
| HTML returned from an API URL | Check the deployed Caddy config and the frontend build origin. Use `/api/health` to distinguish the services. |
| Login loops or mutations return 403 | Verify the exact HTTPS origin, the Secure session cookie, and the Origin and CSRF headers. Rebuild if the hostname changed. |
| API fails startup or returns 503 | Check DB health, role grants, migration revision, SCRAM credentials, the certificate SAN and CA mount. Confirm the URLs use `sslmode=verify-full`. |
| Journal works but AI fails | Check backend provider configuration, connectivity, and quota. Recreate the API container after changing its env file. |
| Recording fails | Confirm microphone permission, WebM/Opus support, backend key, and the upload size limit. |

Run `stage ps` and `stage logs --tail=100 api web db` on the host. Keep sensitive
logs and environment output out of issue reports. The staging container CI test
uses disposable credentials and checks HTTPS routing without calling providers.
