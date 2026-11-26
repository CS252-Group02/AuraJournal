FROM node:22-alpine AS frontend
WORKDIR /source
COPY package.json package-lock.json ./
RUN npm ci
COPY src/frontend/ src/frontend/
ARG STAGING_HOST
RUN test -n "$STAGING_HOST" && VITE_API_URL="https://$STAGING_HOST" npm run build
COPY deploy/staging/Caddyfile /source/Caddyfile
# Keep the existing pre-paint theme script compatible with staging CSP.
RUN node -e 'const fs = require("node:fs"), crypto = require("node:crypto"); \
    const html = fs.readFileSync("src/frontend/dist/index.html", "utf8").replace(/\r\n?/g, "\n"); \
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; \
    if (scripts.length !== 1) throw new Error("Expected one inline theme script"); \
    const hash = crypto.createHash("sha256").update(scripts[0][1]).digest("base64"); \
    fs.writeFileSync("Caddyfile", fs.readFileSync("Caddyfile", "utf8").replace("THEME_SCRIPT_HASH", hash));'

FROM caddy:2.11-alpine AS web
COPY --from=frontend /source/src/frontend/dist/ /srv/
COPY --from=frontend /source/Caddyfile /etc/caddy/Caddyfile

FROM python:3.12-slim AS api
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# Preserve the repository-relative paths used by Alembic and app config.
WORKDIR /app/src/backend
COPY src/backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY src/backend/app/ app/
COPY src/backend/migrations/ migrations/
COPY src/backend/alembic.ini ./
RUN groupadd --gid 10001 aura && useradd --uid 10001 --gid aura --no-create-home aura && mkdir /journal-images && chown aura:aura /journal-images
USER aura
