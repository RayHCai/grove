# syntax=docker/dockerfile:1
# The deployable grove-asset-upload-service image. The build context is the repository root, not this
# directory: the lockfile and the release profile live at the Cargo workspace root above, and the
# health probe the runtime stage needs is built from `tools/`.
#
#     docker build -f apps/grove/asset-upload-service/Dockerfile -t grove-asset-upload-service .
ARG RUST_IMAGE=rust:1.98.1-bookworm
ARG GO_IMAGE=golang:1.26-bookworm

FROM ${RUST_IMAGE} AS build
WORKDIR /src
# `aws-lc-sys` under rustls compiles C, and its build script wants python to drive that.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# The manifests first, with a placeholder entry point for each member: this compiles every dependency
# of this crate and none of its own code, so the layer survives any edit under `src/` and only a
# changed lockfile rebuilds it. The sibling member is named because a workspace root that cannot find
# one is a manifest cargo refuses to read — nothing of it is built here, which is what keeps V8 out of
# this image's build.
COPY apps/grove/Cargo.toml apps/grove/Cargo.lock apps/grove/rust-toolchain.toml ./
COPY apps/grove/asset-upload-service/Cargo.toml ./asset-upload-service/
COPY apps/grove/game-instance/Cargo.toml ./game-instance/
RUN mkdir -p asset-upload-service/src game-instance/src \
    && echo 'fn main() {}' | tee asset-upload-service/src/main.rs game-instance/src/main.rs >/dev/null
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --package grove-asset-upload-service

# The real sources over the placeholder. `touch`, because cargo decides what is stale by timestamp and
# a copied file can land with one older than the placeholder build it has to invalidate.
COPY apps/grove/asset-upload-service ./asset-upload-service
RUN touch asset-upload-service/src/main.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --package grove-asset-upload-service --bin grove-asset-upload-service

# Seeded here so the runtime stage can own it: that stage has no shell to `mkdir` with, and a named
# volume mounted over this path takes its ownership from what the image has at it.
RUN mkdir -p /seed/objects

FROM ${GO_IMAGE} AS health
WORKDIR /src
COPY go.mod ./
COPY tools/healthcheck ./tools/healthcheck
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/grove-healthcheck ./tools/healthcheck

# `cc` rather than `static`: this binary is dynamically linked against the builder's glibc. No shell
# and no package manager either way, and non-root already.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=health /out/grove-healthcheck /usr/local/bin/grove-healthcheck
COPY --from=build /src/target/release/grove-asset-upload-service /usr/local/bin/grove-asset-upload-service
# 65532 is distroless's `nonroot`, named numerically because this stage has no `chown` to resolve it.
COPY --from=build --chown=65532:65532 /seed/objects /var/lib/grove/objects
EXPOSE 4005
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/grove-healthcheck", "-addr-env", "ASSET_UPLOAD_SERVICE_BIND", "-port", "4005"]
ENTRYPOINT ["/usr/local/bin/grove-asset-upload-service"]
