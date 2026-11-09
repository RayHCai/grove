# apps/grove: agent instructions

The root `AGENTS.md` applies here in full. This file holds what differs: three languages share this
directory, and each has its own gate.

## Services

| Package                       | Language | Local port | Role                                                                         |
| ----------------------------- | -------- | ---------- | ---------------------------------------------------------------------------- |
| `@grove/api`                  | TS       | 4000       | Accounts, games, social, and the allocator that mints join tickets           |
| `@grove/game-manager`         | Go       | 4001       | Game data for running sessions; the only thing between a game process and it |
| `@grove/game-builder`         | TS       | 4002       | Compiles a creator's source into the bundle set a session loads              |
| `@grove/server-manager`       | Go       | 4003       | The fleet load balancer: which box a version deploys to and a player joins   |
| `@grove/instance-manager`     | Go       | 4004       | The agent on one box: supervises its game processes and reports capacity up  |
| `@grove/asset-upload-service` | Rust     | 4005       | Inspects every uploaded asset before the CDN may serve it                    |
| `@grove/game-instance`        | Rust     | (per box)  | One game session in one process: sockets, clock, isolate, drain              |
| `@grove/platform`             | React    | 5175       | Browsing, sign-in, a creator's own games                                     |
| `@grove/editor`               | React    | 5176       | The game editor                                                              |
| `@grove/player-app`           | React    | 5177       | The origin a game renders on                                                 |
| `@grove/infra`                | HCL      |            | The AWS deployment; see `infra/AGENTS.md`                                    |

## Rust

`Cargo.toml` here is the workspace root for `game-instance`, `asset-upload-service` and `request-id`,
and `rust-toolchain.toml` pins the toolchain, because a float difference between two toolchains is a
desync. Package scripts shell to `scripts/cargo.mjs`: `typecheck` is clippy under `-D warnings`,
`format` is `cargo fmt --all` over the whole workspace. `game-instance`'s `build` first bundles
`@platform/sim` into the `dist/sim.js` its binary loads, so a sim change is not live in the host
until that rebuilds.

## Go

Every Go package, here and in `libs/go-grove` and `tools/healthcheck`, is one module rooted at the
repository's `go.mod`, so `go build ./...` from the root is all of them. Package scripts shell to
`scripts/go.mjs`; `typecheck` is `go vet` plus staticcheck, whose version is pinned in
`scripts/staticcheck.mjs`. `-race` needs cgo and so runs only as its own CI job: make shared state
safe by construction (a mutex, one writer per slot) rather than relying on catching it locally.

## Browser apps

`platform`, `editor` and `player` are Vite apps over `@grove/ui`; their `dev` builds `@grove/ui`
first. Build-time configuration is `VITE_*`, listed in each app's `.env.example`. Suites run under
jsdom and mount through `@grove/ui/testing`, whose `unmountAll()` each setup file calls after every
case: a root left mounted stays subscribed to the router and can hang a suite with no output.
