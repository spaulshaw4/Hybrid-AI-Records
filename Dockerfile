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

# Vite inlines these at build time — must be present during `bun run build`
# (set them in Railway Variables; they are passed as Docker build-args).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_PAYMENTS_CLIENT_TOKEN
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_PAYMENTS_CLIENT_TOKEN=$VITE_PAYMENTS_CLIENT_TOKEN

RUN bun run build
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
