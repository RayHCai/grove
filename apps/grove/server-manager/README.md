# @grove/server-manager

The fleet load balancer and the join router. There is one of it, and it decides which EC2 instance
anything lands on: which boxes a new version of a game goes out to, and which box a joining player is
sent to. Written in Go.

It supervises no process and holds no game data. What runs on one box is `@grove/instance-manager`'s,
and the ticket a player arrives with is `@grove/api`'s — this service is not publicly routable and
never sees one.

## The registry

Every box in the fleet runs an `@grove/instance-manager`, and each one heartbeats in with its
capacity and every instance it is running. That is the entire picture this service routes on.

A box that has not been heard from inside `HOST_STALE_AFTER` is unhealthy and takes no new work. It
is kept rather than deleted, because a box that comes back from a partition should resume rather than
be re-provisioned as though it had never existed, and `GET /v1/hosts` reports it either way — a box
that is down is a fact an operator needs.

`healthy` follows when a beat arrived here and never a claim a box made about itself, so a skewed
clock on one box cannot keep it in rotation. Its address is taken from the connection the beat came
over for the same reason: a box that named its own address could point joining players elsewhere.

The registry is a map behind a mutex, built in `main.go`. That is the seam a datastore lands on — a
second replica of this service shares one registry rather than each holding half the fleet.

## Placement

`POST /v1/placements` is the call `@grove/api`'s allocator makes before it signs a ticket, so it sits
on the path of every player who ever joins a game. It is answered from the heartbeats already in
hand: one read of the registry and one ranking, and no call to any box. Asking the fleet at request
time would put the slowest machine in it on that path.

A box qualifies when it is healthy, has a free instance slot, and sits in the requested region. A
named region is a filter rather than a preference — a caller asks for one to bound latency, and
honouring it only when convenient makes that latency unpredictable.

`fleet.Balancer` ranks what is left, and `MostFree` fills the emptiest box first so the fleet's
headroom stays pooled rather than spread a slot at a time across every box, where nothing large can
land. Ties break on the lower `hostId`: two identical requests must land on the same box, or one
game's players scatter across the fleet a join at a time. Nothing qualifying is a 409 `conflict`,
which is what a full fleet looks like from the API — and an empty one too, which is why holding no
boxes never makes this process unready.

A placement joins the session the chosen box already runs for that game when there is one. A game is
a world its players share, and a second process would be a second world.

## Deployment

`POST /v1/deployments` names the healthy boxes a version goes out to. Naming regions is what makes a
rollout staged; naming none is the whole fleet. It gates placement on nothing — a box pulls the
bundle set by hash when it spawns a process, so a placement on a box that has not pulled yet is a
cold start rather than a failure.

## Routes

| Route                               | Answers                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `GET /health`                       | that this process is listening, and nothing else       |
| `GET /ready`                        | the same, since nothing here has to become true first  |
| `POST /v1/hosts/{hostId}/heartbeat` | 204; upserts the box and every instance it reported    |
| `GET /v1/hosts`                     | the fleet as this service sees it, ordered by `hostId` |
| `POST /v1/placements`               | a `Placement`, or 409 `conflict` when no box qualifies |
| `POST /v1/deployments`              | a `Deployment`, naming the boxes the version reached   |

Everything under `/v1` sits behind one middleware that compares `FLEET_SECRET` in constant time.
`GET /health` and `GET /ready` are outside it, because a supervisor polls those before this process
holds a credential to check anything against. `FLEET_SECRET` is a different secret from
`GAME_TOKEN_SECRET`, which signs a browser's join ticket and belongs to the two services at either
end of one.

Bodies and rows are `libs/go-grove/contract`'s, which mirrors the zod schemas in
`libs/api-contract` — a timestamp crosses as the RFC 3339 string `z.iso.datetime()` reads.

## Configuration

| Variable              | What                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `SERVER_MANAGER_HOST` | address to bind, `0.0.0.0` by default — every box dials this one |
| `SERVER_MANAGER_PORT` | port to bind, `4003` by default                                  |
| `FLEET_SECRET`        | the shared bearer every caller under `/v1` presents, 32 bytes up |
| `HOST_STALE_AFTER`    | how long a box may go unheard before it takes no work, `30s`     |
| `GROVE_ENV`           | `development`, `test` or `production`; chooses the log handler   |

Every problem with the environment is reported at once rather than one restart at a time, which is
what `libs/go-grove/env` is for.

## Layout

| File              | Holds                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| `main.go`         | the composition root: the environment, the registry, the listener     |
| `internal/config` | the variables this process is started with                            |
| `internal/fleet`  | the registry, the ingress a placement is dialled at, and the balancer |
| `internal/api`    | the fleet-bearer gate, the four routes behind it, and the open two    |

`pnpm run build | test | typecheck` at the repo root reach this module through `package.json`, whose
scripts shell to `go`, and `typecheck` on to `staticcheck`, which is its own binary and can be
missing on a machine that has Go. Either one absent from `PATH` prints one `skipped:` line and
succeeds, so working on the TypeScript half of the fleet does not require installing Go — except in
CI, which names both in `GROVE_REQUIRE_TOOLCHAIN` and fails the gate there rather than skipping.
