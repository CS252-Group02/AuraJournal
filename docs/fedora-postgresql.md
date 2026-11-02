# PostgreSQL Setup on Fedora

These notes cover Fedora's packaged PostgreSQL service for local AuraJournal development. PostgreSQL must be running before starting the backend.

## Initialize and start PostgreSQL

Install Fedora's client and server packages if needed. Fedora stores its database cluster in `/var/lib/pgsql/data`. Initialize the cluster once on a fresh installation, then enable and start the service:

```bash
sudo dnf install postgresql postgresql-server
sudo postgresql-setup --initdb --unit postgresql
sudo systemctl enable --now postgresql
```

If initialization reports that the data directory is not empty, do not delete it or force initialization. It may contain an existing cluster. Check the service and its logs:

```bash
sudo systemctl status postgresql --no-pager
sudo journalctl -u postgresql -b --no-pager -n 60
```

If the cluster is already initialized but the service is stopped, start it with `sudo systemctl start postgresql`; do not run initialization again.

## Create the app role and database

Once PostgreSQL is active, open an administrative prompt:

```bash
sudo -u postgres psql
```

At the `postgres=#` prompt, create the role and database. Run these commands only once. The example role password is `aurajournal`, matching `.env.example`:

```sql
CREATE USER aurajournal WITH PASSWORD 'aurajournal';
CREATE DATABASE aurajournal OWNER aurajournal;
```

If the role already exists, set its password instead:

```sql
ALTER ROLE aurajournal WITH PASSWORD 'aurajournal';
```

If you use a different password, update the password in your local `.env` file's `DATABASE_URL`. Exit `psql` with `\q`.

## Allow password authentication from this computer

Fedora's PostgreSQL configuration may use `ident` for TCP connections. AuraJournal connects to `localhost` with a PostgreSQL username and password, so an `ident` rule can reject the connection even when the password is correct.

Edit the host rules:

```bash
sudoedit /var/lib/pgsql/data/pg_hba.conf
```

For rules matching the IPv4 and IPv6 loopback addresses (`127.0.0.1/32` and `::1/128`), change the authentication method from `ident` to `scram-sha-256`. Leave `local` rules unchanged, and do not broaden the address range. PostgreSQL applies the first matching rule, so edit the matching loopback entries in place.

Reload PostgreSQL and confirm it is active:

```bash
sudo systemctl reload postgresql
systemctl is-active postgresql
```

The loopback rules allow password-authenticated connections from this computer only. Keep the example password for local development only; use a unique password and update `.env` if needed. See [Fedora's PostgreSQL guide](https://developer.fedoraproject.org/tech/database/postgresql/about.html) and PostgreSQL's [client authentication documentation](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html).
