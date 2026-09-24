# syntax=docker/dockerfile:1
# One box of the fleet, for `compose.yaml` only. Nothing deploys from this file: a real box is an EC2
# instance that Terraform brings up, where `user-data` writes an environment file and a systemd unit
# and the two binaries are installed under `/opt/grove/bin`. This is the same pair of processes with
# the same relationship, arranged so one machine can run a session end to end.
#
# The agent and the game binary share an image because they share a filesystem: `instance-manager`
# launches `GAME_INSTANCE_BIN` as a child and reads its health over loopback, so an image holding only
# the agent is a box that can start nothing.
#
#     docker build -f docker/local-fleet-box.Dockerfile -t grove-local-fleet-box .
ARG GO_IMAGE=golang:1.26-bookworm
ARG RUST_IMAGE=rust:1.98.1-bookworm

FROM ${GO_IMAGE} AS agent
WORKDIR /src
COPY go.mod ./
COPY libs/go-grove ./libs/go-grove
COPY tools/healthcheck ./tools/healthcheck
COPY apps/grove/instance-manager ./apps/grove/instance-manager
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go build -trimpath -ldflags='-s -w' -o /out/grove-instance-manager ./apps/grove/instance-manager \
    && go build -trimpath -ldflags='-s -w' -o /out/grove-healthcheck ./tools/healthcheck

FROM ${RUST_IMAGE} AS session
WORKDIR /src
# `deno_core` links a prebuilt V8, which its build script needs a C toolchain and python to place.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# The manifests first, with a placeholder entry point for each member: V8 is the expensive half of this
# build and it belongs to a dependency, so it is linked in a layer that only a changed lockfile
# invalidates rather than on every edit to a source file below it.
COPY apps/grove/Cargo.toml apps/grove/Cargo.lock apps/grove/rust-toolchain.toml ./
COPY apps/grove/game-instance/Cargo.toml ./game-instance/
COPY apps/grove/asset-upload-service/Cargo.toml ./asset-upload-service/
RUN mkdir -p game-instance/src asset-upload-service/src \
    && echo 'fn main() {}' | tee game-instance/src/main.rs asset-upload-service/src/main.rs >/dev/null
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --package grove-game-instance

# The real sources over the placeholder. `touch`, because cargo decides what is stale by timestamp and
# a copied file can land with one older than the placeholder build it has to invalidate.
COPY apps/grove/game-instance ./game-instance
RUN touch game-instance/src/main.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --package grove-game-instance --bin grove-game-instance

# A full userland rather than a distroless base, because this stands in for a Linux box: the agent
# forks a child process, supervises it, and outlives a restart by adopting what it finds still running.
FROM debian:12-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=agent /out/grove-healthcheck /usr/local/bin/grove-healthcheck
COPY --from=agent /out/grove-instance-manager /usr/local/bin/grove-instance-manager
COPY --from=session /src/target/release/grove-game-instance /usr/local/bin/grove-game-instance

# The children this agent started, and the build output it has fetched, one file per content hash. A
# named volume mounted here takes its ownership from what the image has at it, which is why the user
# exists before the directory does.
RUN useradd --system --create-home --uid 10001 grove \
    && install -d -o grove -g grove /var/lib/grove/bundles
USER grove
EXPOSE 4004
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/grove-healthcheck", "-port-env", "INSTANCE_MANAGER_PORT", "-port", "4004"]
ENTRYPOINT ["/usr/local/bin/grove-instance-manager"]
