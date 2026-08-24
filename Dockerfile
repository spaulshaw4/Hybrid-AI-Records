FROM oven/bun:latest
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg python3 && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lockb* bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
ENV NODE_ENV=production
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_PUBLISHABLE_KEY=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
RUN bun run build
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
