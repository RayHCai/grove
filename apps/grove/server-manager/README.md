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

A box that has not been heard from inside `HOST_STALE_AFTER` takes no new work. It is kept for 120 of
those windows rather than deleted, because a box that comes back from a partition should resume
rather than be re-provisioned as though it had never existed, and `GET /v1/hosts` reports it either
way — a box that is down is a fact an operator needs. One gone longer than that is dropped on the
next beat from any box, since one that returns re-registers itself.

Liveness follows when a beat arrived here and never a claim a box made about itself, so a skewed
clock on one box cannot keep it in rotation. Its address is taken from the connection the beat came
over for the same reason: a box that named its own address could point joining players elsewhere.

| Liveness    | Means                                               | Takes work |
| ----------- | --------------------------------------------------- | ---------- |
| `healthy`   | beat inside the window, nothing against it          | yes        |
| `suspected` | work this service dispatched just failed against it | no         |
| `left`      | its own last beat said it was going                 | no         |
| `failed`    | silent past the window, having said nothing         | no         |

`left` and `failed` are the same silence, and the difference is whether the box said goodbye first —
which is the difference between a deploy and a page. It outranks silence permanently: a box that left
stays left however long ago that was, or every rollout ages into an incident an hour later.

`suspected` is evidence from the data path, which arrives before the staleness window and never after
it — a redeploy that went unanswered is a box in trouble now, not in twenty seconds. The box's own
next beat clears it, so a single lost packet costs one interval of placement rather than an eviction.

A beat also carries an incarnation, minted when the agent starts. `hostId` survives a reboot on
purpose, so without it a box that crashed and came back inside the window is a restart nothing here
could see — every beat looks the same, and the worlds the previous life was running are merely
absent.

The registry is a map behind a mutex, built in `main.go`. That is the seam a datastore lands on — a
second replica of this service shares one registry rather than each holding half the fleet. What one
interval of beats cannot rebuild is what the fleet _did_, which is why the transitions go to
`@grove/api` rather than staying here.

## The report

Each transition is recorded once, when it happens — not once per sweep, or a box down overnight is
thousands of identical rows. `FLEET_REPORT_INTERVAL` both sweeps for boxes gone quiet and posts what
the sweep found to `API_URL`, under the same fleet bearer every other service-to-service call
presents. One ticker for both, because the sweep is what produces the rows the report carries.

The whole fleet goes in every report rather than a delta, for the reason a beat carries every
instance: a dropped report costs nothing to recover, and a receiver that missed one is never left
describing a fleet as it was. The snapshot needs no retry — the next one supersedes it — but the
events do, and a report that failed puts them back for the next one. Each carries an id minted here,
so a retry lands on the row it already wrote rather than a second copy of it.

Unset `API_URL` reports to nothing, which is what a development box with no `@grove/api` beside it
runs: the registry still routes, and only the history is lost.

## Placement

`POST /v1/placements` is the call `@grove/api`'s allocator makes before it signs a ticket, so it sits
on the path of every player who ever joins a game. It is answered from the heartbeats already in
hand: one ranking over what they report, one record of where it sent the player, and no call to any
box. Asking the fleet at request time would put the slowest machine in it on that path.

A join waits in a line before it is ranked, and one worker empties that line. One worker, because the
decision below it is already a single critical section: a second would buy no throughput and would
take the ordering away, leaving arrival order to be whichever goroutine the runtime handed the mutex
to. The line is where a burst is absorbed — past `JOIN_QUEUE_DEPTH` a join is refused with a 500 and
nothing is added, since a line that accepted past its cap would stay above it behind entries no
caller is waiting on, and a 409 would tell `@grove/api` the fleet is full when it is this service
that is behind. A join still waiting at `JOIN_DEADLINE` is answered 409, which is a game a player
cannot get into and the only shape that caller has for one; the deadline is refused at startup unless
it sits inside the two seconds `@grove/api` aborts at, because a deadline past that is one no join
could ever reach. `JOIN_QUEUE_URL` holds the line in a cache, where its depth is something an
operator can read while players are in it, and unset it is a line in this process, which is what one
box running the whole fleet locally has. The registry is one map per process either way: a second
replica needs the datastore that seam is waiting for, and a shared line is not it.

A box qualifies when it is healthy, has an instance slot free of both what it reports running and
what has been placed on it since, and sits in the requested region. A named region is a filter
rather than a preference — a caller asks for one to bound latency, and honouring it only when
convenient makes that latency unpredictable.

A join names the version it is for, and the code to start it on. Which version is newest is
`@grove/api`'s answer and never this service's: a router ranking over what its boxes happen to be
running has no answer at all for the first player into a game nobody is playing. What that buys is
a filter — a world on another revision is never joined, however healthy, because a rollout leaves
the old one draining and a browser sent into it holds none of its own scripts. Two versions of one
game are two worlds, and the line holds a reservation per version for the same reason.

`fleet.Balancer` orders what is left, and `MostFree` fills the emptiest box first so the fleet's
headroom stays pooled rather than spread a slot at a time across every box, where nothing large can
land. Ties break on the lower `hostId`: two identical requests must land on the same box, or one
game's players scatter across the fleet a join at a time. A join whose first box filled between that
ranking and the placement takes the next box in the order rather than failing. Nothing qualifying is
a 409 `conflict`, which is what a full fleet looks like from the API — and an empty one too, which
is why holding no boxes never makes this process unready.

A placement joins the session the chosen box already runs for that world when there is one, and the
session placed on it that the box has yet to report healthy the same way, until a beat names that
session draining or unhealthy and the next joiner ranks again rather than being sent into a world
that is shutting down. A world is one its players share, and a second process would be a second
world. A beat from that box that does not name the session releases it, because a box that never
took the work must not hold the next joiner to it, and a beat that does name it hands its slot back
to the running count the box now keeps it in.

Reaching a box nothing is running the world on is where this service makes its one call outward:
`POST /v1/instances` on the chosen box's agent, carrying the version and the bundle refs the join
named. Only the join that reserved the world makes it — every joiner behind that one finds the
reservation and waits on the one process, because a second start of one session is a second world
half the players would be talking to. It happens outside the registry lock, since it is a call to
another machine and the registry is what every other join in the fleet is waiting on, and inside
`START_TIMEOUT`, which has to sit within `JOIN_DEADLINE` or it is an answer arriving after the
player was told no. A box that refuses releases the reservation rather than leaving it: held, every
later joiner would be handed a session whose process nothing is ever going to spawn.

The url a placement carries dials the game process itself, at the port the box bound. That port is
read off the box's own answer to the start rather than waited for, because a placement handed out
with no port is an address no player can dial for the whole heartbeat it would take to learn one; a
join into a session already running takes it from the beat instead. `INGRESS_SCHEME` spells the
scheme, `wss` unless a deployment asks for `ws` — it describes whatever fronts the fleet, since a
box serves the socket itself in plaintext.

## Deployment

`POST /v1/deployments` forwards a redeploy to every box holding a world of the game, all of them at
once, and answers with one row per box. Naming regions is what makes a rollout staged; naming none is
the whole fleet. A box holding nothing of that game is never dialled and has no row, so a version of
a game nobody is playing costs a rollout no connections at all — and a box this service handed a
placement to seconds ago is dialled anyway, because the world it is starting is one its next beat has
yet to name and a rollout blind to it would leave that box alone on the old code.

This service deploys nothing: what a box runs is decided at start, from the bundle refs its start
request carries, so the whole of this is a relay. A box answers `draining` with the
worlds it marked or `skipped` with none, and `failed` is the one verdict written here, for a box that
never answered — a box cannot report itself unreachable. The answer is 200 even when every row
failed, because the shared error body scrubs anything above 499 and a 502 would erase the report the
route exists to deliver. Each box is asked inside its own `AGENT_TIMEOUT` rather than against the
whole fan-out's, so a handful of wedged boxes cannot spend the budget the rest of the fleet is still
answering inside and turn healthy boxes into failed rows.

A box ends a marked world when its last player leaves, so a rollout throws nobody out of a game, and
the next join there starts a fresh process. The rows are taken as the boxes answer them rather than
waited for: the next beat from a box is the authority and overwrites what is recorded here, but it is
a whole heartbeat away, and every joiner placed in between would be sent into a world already ending.

## Routes

| Route                               | Answers                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `GET /health`                       | that this process is listening, and nothing else       |
| `GET /ready`                        | the same, since nothing here has to become true first  |
| `POST /v1/hosts/{hostId}/heartbeat` | 204; upserts the box and every instance it reported    |
| `GET /v1/hosts`                     | the fleet as this service sees it, ordered by `hostId` |
| `POST /v1/placements`               | a `Placement`, or 409 `conflict` when no box qualifies |
| `POST /v1/deployments`              | a `Deployment`, one row per box the version reached    |

Everything under `/v1` sits behind one middleware that compares `FLEET_SECRET` in constant time.
`GET /health` and `GET /ready` are outside it, because a supervisor polls those before this process
holds a credential to check anything against. `FLEET_SECRET` is a different secret from
`GAME_TOKEN_SECRET`, which signs a browser's join ticket and belongs to the two services at either
end of one.

Bodies and rows are `libs/go-grove/contract`'s, which mirrors the zod schemas in
`libs/api-contract` — a timestamp crosses as the RFC 3339 string `z.iso.datetime()` reads.

## Configuration

| Variable                | What                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `SERVER_MANAGER_HOST`   | address to bind, `0.0.0.0` by default — every box dials this one     |
| `SERVER_MANAGER_PORT`   | port to bind, `4003` by default                                      |
| `FLEET_SECRET`          | the shared bearer every caller under `/v1` presents, 32 bytes up     |
| `HOST_STALE_AFTER`      | how long a box may go unheard before work stops, positive, `20s`     |
| `INGRESS_SCHEME`        | `wss` or `ws`, the scheme a placement url is handed out under        |
| `JOIN_QUEUE_URL`        | `redis://[:password@]host[:port][/db]`; unset is a line in-process   |
| `JOIN_QUEUE_KEY`        | the key the line is held under, `grove:joins` by default             |
| `JOIN_QUEUE_DEPTH`      | joins that may be waiting before one is refused, positive, `256`     |
| `JOIN_DEADLINE`         | how long a join may wait, positive and under 2s, `1.5s`              |
| `START_TIMEOUT`         | how long a box may hold a start, under the above, `1s`               |
| `DEPLOY_TIMEOUT`        | how long a whole fan-out may take, `20s`                             |
| `AGENT_TIMEOUT`         | how long one box may hold its own answer, at most the above, `5s`    |
| `API_URL`               | where the fleet's history is kept; unset reports to nothing          |
| `FLEET_REPORT_INTERVAL` | how often the fleet is swept and reported, at most the window, `15s` |
| `GROVE_ENV`             | `development`, `test` or `production`; chooses the log handler       |

Every problem with the environment is reported at once rather than one restart at a time, which is
what `libs/go-grove/env` is for.

## Layout

| File              | Holds                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `main.go`         | the composition root: the environment, the registry, the line, the listener                   |
| `internal/config` | the variables this process is started with                                                    |
| `internal/fleet`  | the registry, its history, the reporter, the ingress, the balancer, and the agent             |
| `internal/joins`  | the line a join waits in, the worker that empties it, and the RESP client it may be held over |
| `internal/api`    | the fleet-bearer gate, the four routes behind it, and the open two                            |

`pnpm run build | test | typecheck` at the repo root reach this module through `package.json`, whose
scripts shell to `go`, and `typecheck` on to `staticcheck`, which is its own binary and can be
missing on a machine that has Go. Either one absent from `PATH` prints one `skipped:` line and
succeeds, so working on the TypeScript half of the fleet does not require installing Go — except in
CI, which names both in `GROVE_REQUIRE_TOOLCHAIN` and fails the gate there rather than skipping.
