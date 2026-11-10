-- Run with psql as a database administrator, in the AuraJournal database,
-- AFTER migrating to 0005. Back up and verify a restore first.
-- Idempotent and transactional. No credentials are stored in this file.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='aurajournal_owner') THEN
    CREATE ROLE aurajournal_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='aurajournal_runtime') THEN
    CREATE ROLE aurajournal_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
-- Refuse unsafe pre-existing role definitions rather than silently reusing them.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('aurajournal_owner','aurajournal_runtime')
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
     OR EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='aurajournal_runtime')) THEN
    RAISE EXCEPTION 'Review privileged roles or runtime memberships before provisioning';
  END IF;
END $$;
ALTER DATABASE :"DBNAME" OWNER TO aurajournal_owner;
ALTER SCHEMA public OWNER TO aurajournal_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
REVOKE ALL ON DATABASE :"DBNAME" FROM aurajournal_runtime;
GRANT CONNECT ON DATABASE :"DBNAME" TO aurajournal_runtime;
REVOKE ALL ON SCHEMA public FROM aurajournal_runtime;
GRANT USAGE ON SCHEMA public TO aurajournal_runtime;
DO $$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['users','journal_entries','mood_records','journal_images',
                              'auth_sessions','login_attempts','rate_limit_buckets','alembic_version'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO aurajournal_owner', item);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, aurajournal_runtime', item);
    IF item <> 'alembic_version' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO aurajournal_runtime', item);
    END IF;
  END LOOP;
END $$;
-- No blanket default DML grants: future migrations must explicitly grant access
-- to new tables. UUID-based current tables need no sequence privileges.
ALTER DEFAULT PRIVILEGES FOR ROLE aurajournal_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
COMMIT;
-- Set passwords interactively with \password, after SET password_encryption='scram-sha-256'.
