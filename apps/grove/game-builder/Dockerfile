# syntax=docker/dockerfile:1
# The deployable @grove/game-builder image. The build context is the repository root, not this
# directory: the lockfile, the workspace manifest and `tsconfig.base.json` are all inputs this package
# cannot resolve on its own.
#
#     docker build -f apps/grove/game-builder/Dockerfile -t grove-game-builder .
ARG NODE_IMAGE=node:24.16.0-bookworm-slim
ARG PNPM_VERSION=11.1.2
ARG TURBO_VERSION=2.10.7

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=/usr/local/share/pnpm:${PATH}
ENV npm_config_store_dir=/pnpm-store
ENV TURBO_TELEMETRY_DISABLED=1
ENV DO_NOT_TRACK=1
# The root `prepare` writes git hooks, and no image is a checkout.
ENV GROVE_SKIP_HOOKS=1
# Baked rather than fetched on first use, so no build stage races corepack's download.
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /repo

# The workspace reduced to this service and the eleven packages it depends on. Everything below is
# keyed off the pruned output, so a commit touching an unrelated package invalidates none of it.
FROM base AS prune
ARG TURBO_VERSION
RUN pnpm add --global "turbo@${TURBO_VERSION}"
COPY . .
RUN turbo prune @grove/game-builder --docker --out-dir /prune

# Manifests and the lockfile alone: this is the dependency layer, and it survives every edit that does
# not change a dependency.
FROM base AS install
COPY --from=prune /prune/json/ ./
# The root `prepare` runs on this install and `turbo prune` carries no root script, so without this the
# install fails resolving it — before it can reach the check that would have skipped it.
COPY scripts/install-hooks.mjs ./scripts/install-hooks.mjs
RUN --mount=type=cache,id=grove-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile

FROM install AS build
COPY --from=prune /prune/full/ ./
# `turbo prune` carries no root file that a package does not declare, and every tsconfig extends this.
COPY tsconfig.base.json ./
RUN pnpm exec turbo run build --filter=@grove/game-builder
# Flattens the built package and its production dependencies into one self-contained tree: the eleven
# workspace packages it imports are copied in rather than symlinked out to a repository the runtime
# stage does not have. `--legacy` because the alternative is `inject-workspace-packages` on the
# workspace, which would change how every developer's install resolves these same packages.
RUN --mount=type=cache,id=grove-pnpm-store,target=/pnpm-store \
    pnpm deploy --filter=@grove/game-builder --prod --legacy /service

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /service
COPY --from=build --chown=node:node /service ./
# A creator's build is compiled and bundled under here, so it has to be writable by the service user.
RUN install -d -o node -g node /service/.builds
USER node
# `node` rather than curl: the runtime already ships an HTTP client, and a second one is a second
# stream of advisories to track for no new capability.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.GAME_BUILDER_PORT||4002)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
