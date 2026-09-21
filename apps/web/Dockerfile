# Built from the monorepo root: `docker build -f apps/web/Dockerfile .`
FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile

# Baked in at build time — the client is a static bundle, so this must be
# reachable from the PLAYER'S BROWSER, not just from inside the compose
# network (e.g. http://localhost:4000, or your server's public origin).
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL

# Optional — leave unset to build without Google sign-in (guest/email still work).
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

WORKDIR /app/apps/web
RUN pnpm build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
