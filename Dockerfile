FROM oven/bun:latest
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg python3
COPY package.json bun.lockb* bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
