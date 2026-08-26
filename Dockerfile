# check=skip=SecretsUsedInArgOrEnv
# syntax=docker/dockerfile:1
#
# Intentional deviation from a typical Railway npm/alpine + `vite preview` paste:
# this app is TanStack Start + bun, ships `.output/server/index.mjs`, and needs
# ffmpeg/python at runtime — so we keep oven/bun (not node:alpine) and do not
# use `npm run preview` or a dist-only multi-stage copy.
#
# Vite client tokens: Railway Variables → matching ARG names, then ENV so
# `bun run build` can inline them. Publishable/public client values only —
# never bake STRIPE_SECRET_* or service-role keys into VITE_*.
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

# Build-time Vite client vars (immediately before build; no BuildKit secret mounts).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_PAYMENTS_CLIENT_TOKEN
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SENTRY_DSN
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_PAYMENTS_CLIENT_TOKEN=$VITE_PAYMENTS_CLIENT_TOKEN
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
RUN bun run build

EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
