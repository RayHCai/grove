# Grove

A 2D multiplayer game platform for students, roughly elementary through high school. Younger creators build with blocks; older ones write TypeScript against the same API — the blocks _are_ the TypeScript, rendered differently, so there's a continuous upgrade path instead of a cliff between "toy" and "real" tools.

## The tree

One directory per kind of thing, and a new package belongs to exactly one of them. What decides is
who may depend on it, not what language it is written in.

| Directory      | Holds                                                                           | May be imported by                      |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| `packages/`    | The engine. Scoped `@platform/*`, and the only code a creator's game runs on.   | Anything. Knows nothing about Grove.    |
| `libs/`        | Product code two Grove services share. Scoped `@grove/*`.                       | `apps/`, and each other.                |
| `apps/`        | Deployables — one process or one site each. Scoped `@grove/*`.                  | Nothing. An app is a leaf.              |
| `tools/`       | Small binaries the images need, not the product.                                | Nothing; copied into images.            |
| `integration/` | The engine composed as a game and driven through one. A package, not a suite.   | `bench/`.                               |
| `bench/`       | Tick cost, bytes per tick and GC pressure, measured against the built packages. | Nothing.                                |
| `docs/`        | The creator-facing API surface and the reasoning behind it. Not shipped.        | `packages/engine`'s spec test reads it. |
| `scripts/`     | The toolchain shims every `package.json` shells to, and the repository's gates. | Every package's scripts.                |
| `docker/`      | Images that belong to no single app, and the init hooks the stores need.        | `compose.yaml`.                         |

`packages/` and `libs/` are the split worth stating twice: an engine package may not know that Grove
has accounts, and a `libs/` package may not be reached by a creator's game. The scopes are the
enforcement — an `@platform/*` package importing `@grove/*` is the boundary being crossed.

`apps/grove/*` are the fleet's own services; `apps/playground` is the engine's own harness and ships
to nobody.

## Core packages

| Package              | What it is                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/sim`       | The deterministic fixed-step advance: an input batch in, an output batch out.                            |
| `packages/core`      | Entities, world, behaviors, decorators, dispatcher. No rendering, no network.                            |
| `packages/engine`    | The creator API a script imports, and the composition roots a host stands a game up with.                |
| `packages/glue`      | The composition of one game: a project in, a running world and the sessions that reach it out.           |
| `packages/client`    | Viewer: the mirror world, the client clock, input capture, and the display loop.                         |
| `packages/renderer`  | `IRenderer` interface and the PixiJS implementation.                                                     |
| `packages/scripting` | Script policy and toolchain: one deterministic, content-hashed ESM chunk per side.                       |
| `packages/protocol`  | The shared wire vocabulary: the envelope types both endpoints agree on.                                  |
| `packages/transport` | Per-connection message pipe: a leaf interface with a loopback and a websocket implementation.            |
| `packages/project`   | The authoring shape: the project manifest an editor saves, its validator and migrations.                 |
| `packages/math`      | Pure, dependency-free primitives: vectors, bounds, easing, seeded random, deterministic transcendentals. |

`sim` holds no socket, no clock, and no store — it's hosted by two different processes: `apps/grove/game-instance` (Rust, production) and `packages/glue` running in-process (local preview, in the editor).

## Architecture

**Web.** `apps/grove/platform` is the landing page and sign-in flow; it links out to `apps/grove/editor` (build and publish a game) and `apps/grove/player` (play one). All three are React apps served from Web.

**API and storage.** `apps/grove/api` is the public API — accounts, games, social, and the allocator that mints join tickets — backed by PSQL. It fronts S3 for game bundles and assets, Redis for fast/session state, and EventBridge for async work. `apps/grove/game-builder` compiles a creator's source into the bundle set a session loads, triggered off the upload service and EventBridge, and the result lands in S3 behind CloudFront.

**Fleet (Region, EC2 x N).** `server-manager` (Go) is the fleet load balancer and join router — it decides which box a version deploys to and which box a joining player is sent to. `instance-manager` (Go) is the per-instance agent: it supervises the `game-instance` processes on its box, reads their health and logs, and reports capacity upward to `server-manager`. Each `game-instance` (Rust) is one game session in one process — the sockets, the tick clock, the isolate running `sim`, and the drain — talking to a Game VM. `game-manager` sits between running game processes and their data in DynamoDB.

**Observability.** Sentry and Datadog are wired in independently of the request path.

## Running it locally

`compose.yaml` at the root is for development only — nothing deploys from it. It comes in three
layers, because most work needs only the first. Copy `.env.example` to `.env`, then:

```sh
docker compose up                    # Postgres, Redis and LocalStack
docker compose --profile app up      # and every service, from the images that deploy
docker compose --profile fleet up    # and one box of the fleet, for a session end to end
```

The browser apps are not in there. They deploy to a static host and their dev server already reloads
on an edit, so they run on the host against whichever layer is up:

```sh
pnpm --filter @grove/platform dev    # localhost:5175
pnpm --filter @grove/editor dev      # localhost:5176
pnpm --filter @grove/player-app dev  # localhost:5177
```

| Reached at           | What                                                 |
| -------------------- | ---------------------------------------------------- |
| `localhost:4000`     | `api`                                                |
| `localhost:4001/3/4` | `game-manager`, `server-manager`, `instance-manager` |
| `localhost:4002`     | `game-builder`                                       |
| `localhost:4005`     | `asset-upload-service`                               |
| `localhost:5432`     | Postgres, for `psql` or a GUI on the host            |
| `localhost:6379`     | Redis                                                |
| `localhost:4566`     | LocalStack — S3, and only S3                         |

The stores are the three a deployment hands the fleet, so nothing in a service knows it is running
locally: the games bucket is LocalStack's, reached through `S3_ENDPOINT` with versioning on because a
manifest freezes a version id per file. The one value compose has to contradict is `NODE_ENV`, which
the image sets to `production` and compose sets back — it alone decides whether the session cookie
carries `Secure`, and nothing here terminates TLS.

Running a session end to end also needs build output in the bucket for the agent to fetch, which is a
publish through `game-builder` rather than something compose can stand up on its own.

## Deploying

An image is built from the repository root against the Dockerfile beside the service it builds, because
the lockfile, `tsconfig.base.json` and the root `go.mod` are all inputs a package cannot resolve alone:

```sh
docker build -f apps/grove/api/Dockerfile -t grove-api .
```

| Where     | What                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| Static    | `platform`, `editor`, `player` — built by their own `pnpm build`, no image involved              |
| Container | `api`, `game-builder`, `game-manager`, `server-manager`, `asset-upload-service`                  |
| Fleet     | `instance-manager` and `game-instance`, installed on an EC2 box by Terraform — not as containers |

The fleet is the exception worth stating: a real box runs the two binaries under systemd from
`/opt/grove/bin`, written by the launch template's user-data. `docker/local-fleet-box.Dockerfile` is
the same pair arranged so one machine can hold a session, and it deploys nowhere.

Each containerised service carries a `railway.json` naming its Dockerfile and its health path. The
schema applies migrations for `api` as a pre-deploy command rather than on the way up, so a process
that starts has a schema already.
