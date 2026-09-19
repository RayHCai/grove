# @grove/instance-manager

The agent on one EC2 instance: it supervises the several `@grove/game-instance` processes on this
box, reads their local health and logs, and reports what it sees upward. Written in Go.

It allocates nothing. Which box a session lands on is `@grove/server-manager`'s decision, and this
agent only carries one out — one of these per instance, several game processes per one of these. Not
publicly routable.

## The scope

Every route under `/v1` sits behind the fleet's shared bearer, which `@grove/server-manager` holds
and nothing outside the fleet network does. A shared secret rather than a signed claim because there
is nothing to scope: every route acts on this box, and the only question is whether the caller is
inside the fleet. `/health` and `/ready` sit outside that scope, for whatever supervises this agent.

| Route                                        | Answers                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `GET /ready`                                 | `{"ok":true}` if the game binary is forkable         |
| `GET /health`                                | `{"ok":true}`                                        |
| `POST /v1/instances`                         | the report, port included, 201 — or 409 at the cap   |
| `GET /v1/instances`                          | every instance on this box, oldest first             |
| `GET /v1/instances/{instanceId}`             | one, or 404                                          |
| `DELETE /v1/instances/{instanceId}`          | 204 once the child has drained, or 404               |
| `GET /v1/instances/{instanceId}/logs?limit=` | the tail of that child's output, oldest first        |
| `POST /v1/games/{gameId}/redeploy`           | a `HostDeployment`: the worlds of that game, drained |

A start body names the instance and session ids the placement was answered with, the game, the
version and the bundle refs its code is at. It is a placement already decided upstream, so nothing
here weighs it — a box cannot answer which box should hold a session. The bearer the child presents to
`@grove/game-manager` is signed here from `GAME_TOKEN_SECRET`, so that credential never crosses the
fleet network.

## The code a world runs

A start names a version and where its code lives; this box fetches it. A path chosen upstream would
be one only that machine's filesystem has, and `@grove/server-manager` holds no build output to send
bytes from — so what crosses is a ref, and the fetch is this agent's.

One file per content hash under `BUNDLE_CACHE_DIR`, which is what makes a busy game cheap: the first
session of a version pays the download and every session after it pays a stat. Content-addressed
rather than keyed by game and revision, so a redeploy that changed one half re-fetches only that
half — and a name that is the hash of its own bytes can never be stale. Only the server half and the
sim config come down: the client bundle is fetched by the browser from the same edge, and a box that
pulled it would spend bandwidth on bytes it never opens.

The bytes are hashed as they are written, and a file whose digest is not the name it was fetched
under is refused and kept nowhere. That is the one failure that must never be cached — a box that
kept it would run the wrong code for every session of that version until somebody noticed. A hash
is checked before it becomes a filename, in the contract's own lowercase-hex spelling, because it is
the only part of a start that reaches this box's filesystem at all.

The fetch happens before the instance lock, so one download does not hold up every other start on
the box, and the version travels on into the heartbeat: it is what lets the router tell a world a
joiner's code matches from one still draining on the version before it.

## Supervision

One child process per session, spawned with `os/exec` and held until it ends. Nothing is restarted:
a game-instance that died took its world with it, and a restart would hand its players a world that
never existed. A dead child is reported dead, its last lines are kept, and the session ends there.

A stop is a drain: the child takes `SIGINT`, which is the signal its own shutdown hangs off, and
only a child that ignores it is killed. The 204 comes back after the process is gone, so it means
the last batch of saves is written.

A redeploy is the same ending on a longer clock. Every world of the named game is marked `draining`
at once — the mark is what the next beat carries and what stops `@grove/server-manager` sending
anyone else here — and each one is then held until its last player leaves, at which point it takes
the same drain a stop does. Nobody is thrown out of a game to put a new version on the box, and the
next join starts a fresh process. The roster it waits on is this agent's own reading from the probe,
never a claim a child made, and a world no probe has yet answered for is unknown rather than empty,
so a process is never ended between its spawn and its first player. `INSTANCE_DRAIN_DEADLINE` ends a
drain that never empties, measured from when the drain began rather than from this run of the agent,
so a restart resumes a budget already spent instead of granting a whole new one. A `DELETE` arriving
mid-drain does not wait that budget out: it collapses the drain into an ordinary teardown, which
leaves an operator the same escalation they always had.

The whole of a child's configuration is environment this agent decided:
`GROVE_GAME_ID`, `GROVE_SESSION_ID`, `GROVE_BIND`, `GROVE_BUNDLE`, `GROVE_SIM_CONFIG`,
`GAME_TOKEN_SECRET`, `GROVE_MANAGER_URL`, `GROVE_MANAGER_TOKEN`, `GROVE_HEAP_LIMIT_BYTES` and
`GROVE_TICK_BUDGET_MS`. Nothing the child needs is discovered by the child. The port is part of
that: this box asks the kernel which one is free and hands it over as `GROVE_BIND`, rather than
keeping a range that would drift from what is actually bound here, and holds that number back until
the child ends, because the kernel would offer it again in the window before the child has bound it.
The child inherits none of this box's own environment.

## Local health

Each child is polled on its own `/healthz` over loopback, all of them at once so one that has
stopped answering cannot age every other reading in the beat, and what that reading says is what
the report carries — `starting`, `healthy`, `draining` or `unhealthy` — never a claim a child made
about itself. A probe that fails inside the boot grace leaves an instance `starting`; after it,
unhealthy. A drain is this agent's own decision, and no probe overrides it: while one is draining
the state is pinned and the roster keeps moving, because a reading frozen at the moment of the drain
would never reach the zero the drain is waiting for.

Each child's stdout and stderr land in a bounded ring, so an operator can read why one went
unhealthy without shelling into the box. The buffer holds a fixed number of lines and cuts a run
that never sends a newline, because the point of it is to survive a process that misbehaves.

## The heartbeat

A ticker posts a `HostHeartbeat` to `@grove/server-manager`: this box, its region, the port this
agent listens on, its capacity, and one `InstanceReport` per child it still holds a process for,
each naming the port that child bound — which is the port a player dials, so the router names it
rather than guessing one. Every instance every beat rather than a delta, so a dropped beat costs
nothing to recover, and a reaped child is absent rather than reported dead. A failed beat is logged
and dropped — the next one carries the whole state, and a queue of stale beats would describe a box
as it was.

`cpuLoad` and `memoryFreeBytes` come from `/proc`, normalized by core count so one number compares
two boxes of different sizes, and `cpuLoad` is ceilinged at 1 because the fleet router refuses any
beat above it. Both are zero where the kernel publishes neither: the fleet's hard bound on a box is
its instance cap, and these two only break ties.

Every beat carries an incarnation, minted when this agent starts and fixed for as long as it runs.
`HOST_ID` is kept on disk so a restarted agent keeps the identity the fleet knows it by, which is
exactly what makes a restart invisible without a second one: a box that died and came back inside
the router's staleness window never looked absent, and the worlds its previous life was running are
merely missing from the next beat.

## The farewell

The last thing this process does, after the listener has drained and before it exits, is one beat
marked `leaving`. Silence is how the router finds a crash, so a deploy that simply went quiet reads
as one — this is the beat that says otherwise, and it is what separates `left` from `failed` upward.

The ticker is stopped first, so an ordinary beat cannot race it and say nothing of the sort. It gets
a short budget and a context of its own, because the one that ended the process is already cancelled.
A failure is dropped: the router then concludes `failed` where it would have concluded `left`, which
is a worse operator story and not a wrong one.

The children are still left running. A game in progress outlives the agent that started it, and this
beat announces the agent going, not the box.

## The seams

Five interfaces, and `main.go` is the only file that chooses an implementation for any of them.

| Seam                  | Owns                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `supervisor.Launcher` | what forks a process, the environment it gets, and what adopts one back |
| `supervisor.Prober`   | what asks a child how it is                                             |
| `supervisor.Ports`    | which port a child binds, and when it is free again                     |
| `bundles.Store`       | where a version's code comes from, and what it is kept under            |
| `box.Sampler`         | what the machine itself has left                                        |

The launcher is the one that matters most: everything else in this agent is reachable without a real
binary because of it.

## Running it

```bash
pnpm --filter @grove/instance-manager run build
./dist/instance-manager
```

| Variable                  | What                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `INSTANCE_MANAGER_HOST`   | address to bind, `0.0.0.0` by default                             |
| `INSTANCE_MANAGER_PORT`   | port to bind, `4004` by default                                   |
| `FLEET_SECRET`            | shared with `@grove/server-manager`, both directions, 32 bytes up |
| `SERVER_MANAGER_URL`      | where the beat goes, `https` in production                        |
| `GAME_MANAGER_URL`        | the data plane every child gets; this box holds it, not a join    |
| `HOST_ID`                 | the uuid the fleet knows this box by                              |
| `HOST_REGION`             | which region it sits in                                           |
| `MAX_INSTANCES`           | game processes this box may hold, `8` by default                  |
| `HEARTBEAT_INTERVAL`      | how often it beats, `10s` by default                              |
| `INSTANCE_DRAIN_DEADLINE` | how long a redeployed world waits for its last player, `15m`      |
| `GAME_INSTANCE_BIN`       | the `grove-game-instance` binary it spawns                        |
| `INSTANCE_STATE_DIR`      | where it writes its children down, `/var/lib/grove` by default    |
| `BUNDLE_CACHE_DIR`        | one file per content hash, `/var/lib/grove/bundles` by default    |
| `GAME_TOKEN_SECRET`       | verifies a join ticket in the child, signs the child's own bearer |
| `GROVE_ENV`               | `development`, `test` or `production`; the log level follows it   |

Every problem with that environment is reported in one error, so a box with three unset variables
does not need three restarts to learn that. This agent binds every interface, unlike the services
behind it: `@grove/server-manager` reaches it across the fleet network, and a box no one can address
holds no sessions.

A shutdown here leaves the children running. A game in progress outlives the agent that started it,
and a redeploy of this agent must not end anyone's session. Each child is written down under
`INSTANCE_STATE_DIR` as it starts, so the next run of this agent takes the survivors back rather
than coming up empty on a box that is already full.

`pnpm run build | test | typecheck` at the repo root reach this module through `package.json`, whose
scripts shell to Go — and `typecheck` to `staticcheck` as well, a binary of its own that a machine
with the Go toolchain can still be without. Either one absent prints one `skipped:` line and
succeeds, so working on the TypeScript half of the fleet requires installing neither. CI names both
in `GROVE_REQUIRE_TOOLCHAIN`, where an absence is a broken install and fails the job instead.

The standard library and `@grove/go-grove`, and nothing else. Routing is `net/http` pattern
matching, so `go.sum` stays empty and the build works offline.
