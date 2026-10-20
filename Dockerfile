# syntax=docker/dockerfile:1

# One build stage installs and builds the whole workspace; each target copies only what its
# process needs. Compose builds every target with `docker compose --profile full build`.
# The gateway is the LAST stage on purpose: a plain `docker build .` (as hosts like Render run,
# with no way to pick a target) builds the gateway. Keep it last.
ARG NODE_IMAGE=node:22.23.3-alpine3.24

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first, so dependency layers are reused when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
# Only what the build needs: shared TS config and the workspace packages.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm build
# Self-contained production installs: compiled app, injected shared package, prod deps only.
RUN pnpm deploy --legacy --filter=@ai-gateway/gateway --prod /out/gateway \
 && pnpm deploy --legacy --filter=@ai-gateway/worker --prod /out/worker

FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
CMD ["node", "dist/main.js"]

FROM nginx:1.31.7-alpine3.24 AS dashboard
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html

FROM ${NODE_IMAGE} AS gateway
# Listen on all interfaces inside the container. PORT is a default: platforms that inject their
# own PORT at runtime (Render does) override it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out/gateway ./
USER node
EXPOSE 8080
# node is PID 1 and handles SIGTERM itself (graceful drain).
CMD ["node", "dist/main.js"]
