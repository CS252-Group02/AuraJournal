# Deployed API smoke tests

Run against disposable staging with its own PostgreSQL database and private image
volume. Deploy the commit under test, apply Alembic migrations, and confirm the
applied revision matches the repository head. Use the HTTPS API URL and the exact
configured `FRONTEND_ORIGIN`. See the [deployment guide](security-hardening.md#4-production-environment-and-proxy).

For the normal run, configure `DEEPGRAM_API_KEY` and `GROQ_API_KEY` on the staged
backend. Disable PixelLab on staging for this check to avoid unrelated image
jobs. Create a short WebM/Opus file containing clearly spoken fictional text.
The runner uses this fixture for one live Deepgram request and sends one fictional
journal to Groq for reflection generation.

Run the normal scenario from the repository root with the backend Python environment active.

```sh
python scripts/smoke-api.py --api-url "$STAGING_API_URL" --origin "$STAGING_FRONTEND_ORIGIN" \
  --audio /path/to/fictional-speech.webm
```

Then unset `GROQ_API_KEY` on the isolated staging deployment and restart it. Wait
until the updated instances serve traffic before running the failure scenario.

```sh
python scripts/smoke-api.py --api-url "$STAGING_API_URL" --origin "$STAGING_FRONTEND_ORIGIN" \
  --scenario reflection-unavailable
```

Restore the staging provider configuration afterward. Each run creates a fresh
disposable account and attempts cleanup even when a check fails. If an outage
prevents cleanup, discard the disposable staging data after restoring service.
Keep the exit status and step results for both runs with the deployed commit,
environment, and timestamp. The runner prints step names and HTTP statuses. Both
runs must exit zero to complete deployed verification.
