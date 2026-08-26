# syntax=docker/dockerfile:1
#
# Vite client tokens: prefer BuildKit secret mounts for local/CI builds so values
# are not persisted via ENV in image config. Railway Dockerfile builds do not
# support --secret; they inject matching service variables as ARG (see docs).
# Never promote VITE_* to ENV — that bakes them into the final image metadata.
FROM oven/bun:latest
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg python3 openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lockb* bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# Placeholder URL so prisma.config.ts accepts a datasource during generate (no DB connection).
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?sslmode=disable"
# Generate Prisma client inside the container (output: src/generated/prisma)
RUN bunx --bun prisma generate || bunx prisma generate || npx prisma generate
ENV NODE_ENV=production

# Railway: declare ARG so service Variables are passed as build-args.
# Local/CI: pass the same ids with `docker build --secret id=NAME,env=NAME`.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_PAYMENTS_CLIENT_TOKEN
ARG VITE_SENTRY_DSN

# Vite inlines these at `bun run build`. Secret files override ARG when mounted.
RUN --mount=type=secret,id=VITE_SUPABASE_URL,required=false \
    --mount=type=secret,id=VITE_SUPABASE_PUBLISHABLE_KEY,required=false \
    --mount=type=secret,id=VITE_SUPABASE_ANON_KEY,required=false \
    --mount=type=secret,id=VITE_PAYMENTS_CLIENT_TOKEN,required=false \
    --mount=type=secret,id=VITE_SENTRY_DSN,required=false \
    set -e; \
    for name in \
      VITE_SUPABASE_URL \
      VITE_SUPABASE_PUBLISHABLE_KEY \
      VITE_SUPABASE_ANON_KEY \
      VITE_PAYMENTS_CLIENT_TOKEN \
      VITE_SENTRY_DSN; do \
      if [ -f "/run/secrets/$name" ]; then \
        export "$name=$(cat "/run/secrets/$name")"; \
      fi; \
    done; \
    bun run build

EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
