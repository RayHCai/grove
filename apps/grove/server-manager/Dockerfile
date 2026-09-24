# syntax=docker/dockerfile:1
# The deployable @grove/server-manager image. The build context is the repository root, not this
# directory: the root `go.mod` is what resolves `libs/go-grove` from this tree rather than a proxy.
#
#     docker build -f apps/grove/server-manager/Dockerfile -t grove-server-manager .
ARG GO_IMAGE=golang:1.26-bookworm

FROM ${GO_IMAGE} AS build
WORKDIR /src
# One module with no external requirements, so there is no dependency layer to separate: `go.mod` and
# the two package trees below are the whole input, and a sibling service is not one of them.
COPY go.mod ./
COPY libs/go-grove ./libs/go-grove
COPY tools/healthcheck ./tools/healthcheck
COPY apps/grove/server-manager ./apps/grove/server-manager
# Static, so the runtime stage needs no libc matching the builder's. `-trimpath` keeps the builder's
# absolute paths out of the binary, which is what makes two builds of one commit compare equal.
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go build -trimpath -ldflags='-s -w' -o /out/grove-server-manager ./apps/grove/server-manager \
    && go build -trimpath -ldflags='-s -w' -o /out/grove-healthcheck ./tools/healthcheck

# No shell, no package manager and a non-root user already: the binary is static, so nothing else in a
# userland is reachable from here and none of it has to be patched.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=build /out/grove-healthcheck /usr/local/bin/grove-healthcheck
COPY --from=build /out/grove-server-manager /usr/local/bin/grove-server-manager
EXPOSE 4003
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/grove-healthcheck", "-port-env", "SERVER_MANAGER_PORT", "-port", "4003"]
ENTRYPOINT ["/usr/local/bin/grove-server-manager"]
