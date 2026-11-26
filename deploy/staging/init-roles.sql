-- First boot of an empty staging volume. Set role passwords via psql afterwards.
CREATE ROLE aurajournal_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE aurajournal_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DATABASE aurajournal OWNER TO aurajournal_owner;
ALTER SCHEMA public OWNER TO aurajournal_owner;
REVOKE ALL ON DATABASE aurajournal FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE aurajournal TO aurajournal_runtime;
GRANT USAGE ON SCHEMA public TO aurajournal_runtime;
