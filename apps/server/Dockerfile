# Built from the monorepo root: `docker build -f apps/server/Dockerfile .`
# (docker-compose.yml at the repo root does this for you).
FROM node:22-bookworm-slim

# argon2 needs a native build toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps

# The full workspace is copied (not just apps/server) so pnpm's lockfile,
# which lists every workspace project, resolves cleanly.
RUN pnpm install --frozen-lockfile

WORKDIR /app/apps/server

ENV NODE_ENV=production
EXPOSE 4000

CMD ["pnpm", "start"]
