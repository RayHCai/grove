# @grove/instance-manager

The agent on one EC2 instance: it supervises the several `@grove/game-instance` processes on this
box, reads their local health and logs, and reports what it sees upward. Written in Go.

It allocates nothing. Which box a session lands on is `@grove/server-manager`'s decision, and this
agent only carries one out: one of these per instance, several game processes per one of these. Its
control port is reachable from the fleet's own blocks and the router's, and its player proxy from
anywhere; both serve TLS under one certificate for the box's `PUBLIC_HOST`, required in production.

## The scope

Every route under `/v1` sits behind the fleet's shared bearer, which `@grove/server-manager` holds
and nothing outside the fleet network does. A shared secret rather than a signed claim because there
is nothing to scope: every route acts on this box, and the only question is whether the caller is
inside the fleet. `/health` and `/ready` sit outside that scope, for whatever supervises this agent.

| Route                                        | Answers                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `GET /ready`                                 | `{"ok":true}` if the game binary is forkable         |
| `GET /health`                                | `{"ok":true}`                                        |
| `POST /v1/instances`                         | the report, port included, 201, or 409 at the cap    |
| `GET /v1/instances`                          | every instance on this box, oldest first             |
| `GET /v1/instances/{instanceId}`             | one, or 404                                          |
| `DELETE /v1/instances/{instanceId}`          | 204 once the child has drained, or 404               |
| `GET /v1/instances/{instanceId}/logs?limit=` | the tail of that child's output, oldest first        |
| `POST /v1/games/{gameId}/redeploy`           | a `HostDeployment`: the worlds of that game, drained |
| `GET /play/{instanceId}` (player port)       | the world's WebSocket, carried to its child, or 404  |

The player proxy on `PLAYER_PORT` is the one door players have: no game process binds anything but
loopback, and `/play/{instanceId}` is carried to that world's child at `/play` with the query and the
`Sec-WebSocket-Protocol` that holds the ticket passed as sent. Each upgrade dials a fresh connection,
since the standard library replays a GET whose reused connection failed and a replayed upgrade spends
a single-use ticket twice; a request head gets 4 seconds, inside the child's 5, and past
`PLAYER_MAX_CONNECTIONS` a connection is closed at accept.

A start body names the instance and session ids the placement was answered with, the game, the
version and the bundle refs its code is at, held to the same `contract.BundleSet` check the router
applies. It is a placement already decided upstream, so nothing
here weighs it: a box cannot answer which box should hold a session. It carries the world's store
bearer and when it dies, which `@grove/server-manager` signed and this box hands to the child unread,
so no box holds a key that signs one; a start whose bearer dies inside `REAP_TOKEN_MARGIN` is a 400.

## The code a world runs

A start names a version and where its code lives; this box fetches it. A path chosen upstream would
be one only that machine's filesystem has, and `@grove/server-manager` holds no build output to send
bytes from, so what crosses is a ref, and the fetch is this agent's.

One file per content hash under `BUNDLE_CACHE_DIR`, which is what makes a busy game cheap: the first
session of a version pays the download and every session after it a re-hash, since a spawn runs
whatever the cache holds and a file that no longer matches its name is dropped and fetched again.
Files are written read-only into a directory only this agent may write, so a game process can read
a bundle and never rewrite the one another game is about to run. Content-addressed
rather than keyed by game and revision, so a redeploy that changed one half re-fetches only that
half, and a name that is the hash of its own bytes can never be stale. Only the server half and the
sim config come down: the client bundle is fetched by the browser from the same edge, and a box that
pulled it would spend bandwidth on bytes it never opens.

The bytes are hashed as they are written, and a file whose digest is not the name it was fetched
under is refused and kept nowhere. That is the one failure that must never be cached: a box that
kept it would run the wrong code for every session of that version until somebody noticed. A hash
is checked before it becomes a filename, in the contract's own lowercase-hex spelling, because it is
the only part of a start that reaches this box's filesystem at all.

The fetch happens before the instance lock, so one download does not hold up every other start on
the box. It runs on its own `bundleFetchTimeout` rather than the start request's clock, and every
start of the same version waits on that one download: the router gives up on a start within a
second, and a cold first download that died with it would make every retry start from nothing.
The version travels on into the heartbeat: it is what lets the router tell a world a
joiner's code matches from one still draining on the version before it.

## Supervision

One child process per session, spawned with `os/exec` and held until it ends. Nothing is restarted:
a game-instance that died took its world with it, and a restart would hand its players a world that
never existed. A dead child is reported dead, its last lines are kept, and the session ends there.

A stop is a drain: the child takes `SIGINT`, which is the signal its own shutdown hangs off, and
only a child that ignores it is killed. The 204 comes back after the process is gone, so it means
the last batch of saves is written.

A redeploy is the same ending on a longer clock. Every world of the named game is marked `draining`
at once (the mark is what the next beat carries and what stops `@grove/server-manager` sending
anyone else here), and each one is then held until its last player leaves, at which point it takes
the same drain a stop does. Nobody is thrown out of a game to put a new version on the box, and the
next join starts a fresh process. The roster it waits on is this agent's own reading from the probe,
never a claim a child made, and a world no probe has yet answered for is unknown rather than empty,
so a process is never ended between its spawn and its first player. A push names its revision, and
only the worlds of that game on another one are marked; a push naming none marks them all.
`INSTANCE_DRAIN_DEADLINE` ends a
drain that never empties, measured from when the drain began rather than from this run of the agent,
so a restart resumes a budget already spent instead of granting a whole new one. A `DELETE` arriving
mid-drain does not wait that budget out: it collapses the drain into an ordinary teardown, which
leaves an operator the same escalation they always had.

A world also ends unasked: one empty for `REAP_IDLE` past its boot grace, and one whose store bearer
dies inside `REAP_TOKEN_MARGIN`, drain like a redeploy, held two beats before an empty one ends so the
beat carrying the mark reaches the router first; one that has failed `REAP_UNHEALTHY_PROBES` probes
in a row is taken down at once, since a wedged process never empties.

The whole of a child's configuration is environment this agent decided:
`GROVE_GAME_ID`, `GROVE_SESSION_ID`, `GROVE_BIND`, `GROVE_BUNDLE`, `GROVE_SIM_CONFIG`,
`GROVE_TICKET_PUBLIC_KEYS`, `GROVE_MANAGER_URL`, `GROVE_MANAGER_TOKEN`, `GROVE_HEAP_LIMIT_BYTES` and
`GROVE_TICK_BUDGET_MS`. Nothing the child needs is discovered by the child. The port is part of
that: this box asks the kernel which loopback port is free and hands it over as
`GROVE_BIND=127.0.0.1:<port>`, rather than
keeping a range that would drift from what is actually bound here, and holds that number back until
the child ends, because the kernel would offer it again in the window before the child has bound it.
The child inherits none of this box's own environment.

On Linux each child runs as `GAME_UID`/`GAME_GID` with no supplementary groups, spawned straight into
a cgroup v2 leaf of its own under `CGROUP_ROOT` (`CLONE_INTO_CGROUP`) whose `memory.max` and
`pids.max` are `CHILD_MEMORY_MAX_BYTES` and `CHILD_PIDS_MAX`, and whatever is left in the leaf is
killed with it. Before any spawn the agent clears its ambient capabilities on every thread, since an
ambient set survives exec and a child would otherwise hold `CAP_SETUID`, then moves itself into the
leaf `agent` and turns the memory and pids controllers on below the unit, the order the kernel's
no-internal-processes rule demands. It turns them off as the last thing it does, because systemd
attaches the next run to the unit's own cgroup and the kernel refuses that while they are on; the
next run turns them back on and writes every survivor's bounds again. A sandbox asked for off Linux
is refused at startup rather than skipped.

## Local health

Each child is polled on its own `/healthz` over loopback, all of them at once so one that has
stopped answering cannot age every other reading in the beat, and what that reading says is what
the report carries (`starting`, `healthy`, `draining` or `unhealthy`), never a claim a child made
about itself. A probe that fails inside the boot grace leaves an instance `starting`; after it,
unhealthy. A drain is this agent's own decision, and no probe overrides it: while one is draining
the state is pinned and the roster keeps moving, because a reading frozen at the moment of the drain
would never reach the zero the drain is waiting for.

Each child's stdout and stderr land in a bounded ring, so an operator can read why one went
unhealthy without shelling into the box. The buffer holds a fixed number of lines and cuts a run
that never sends a newline, because the point of it is to survive a process that misbehaves.

## The heartbeat

A ticker posts a `HostHeartbeat` to `@grove/server-manager`: this box, its region, the port this
agent listens on, its `PUBLIC_HOST`, its player port and whether it serves TLS (every url the
router builds to this box comes from these), whether it is ready (its binary forkable and its cache
writable, asked afresh each beat), its capacity, and one `InstanceReport` per child it still holds
a process for. Every instance every beat rather than a delta, so a dropped beat costs
nothing to recover, and a reaped child is absent rather than reported dead. A failed beat is logged
and dropped; the next one carries the whole state, and a queue of stale beats would describe a box
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
as one; this is the beat that says otherwise, and it is what separates `left` from `failed` upward.

The ticker is stopped and waited for first, so an ordinary beat still in flight cannot land after
it and say nothing of the sort. It gets
a short budget and a context of its own, because the one that ended the process is already cancelled.
A failure is dropped: the router then concludes `failed` where it would have concluded `left`, which
is a worse operator story and not a wrong one.

The children are still left running. A game in progress outlives the agent that started it, and this
beat announces the agent going, not the box. The sockets the player proxy was carrying go with the
agent; the worlds stay, and a player's client reaches one again through a fresh placement.

## The seams

Five interfaces, and `main.go` is the only file that chooses an implementation for any of them.

| Seam                  | Owns                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `supervisor.Launcher` | what forks a process, the sandbox and environment it gets, and what adopts one back |
| `supervisor.Prober`   | what asks a child how it is                                                         |
| `supervisor.Ports`    | which port a child binds, and when it is free again                                 |
| `bundles.Store`       | where a version's code comes from, and what it is kept under                        |
| `box.Sampler`         | what the machine itself has left                                                    |

The launcher is the one that matters most: everything else in this agent is reachable without a real
binary because of it.

## Running it

```bash
pnpm --filter @grove/instance-manager run build
./dist/instance-manager
```

| Variable                  | What                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `INSTANCE_MANAGER_HOST`   | address to bind, `0.0.0.0` by default                                    |
| `INSTANCE_MANAGER_PORT`   | control port to bind, `4004` by default                                  |
| `PLAYER_PORT`             | player proxy port, every interface, `4006` by default                    |
| `PLAYER_MAX_CONNECTIONS`  | sockets the proxy holds at once, `1024`, the child's own cap             |
| `PUBLIC_HOST`             | the name players and the router dial; required in production             |
| `TLS_CERT_FILE`           | PEM chain both listeners serve, re-read when it changes                  |
| `TLS_KEY_FILE`            | its key; both or neither, both in production                             |
| `FLEET_SECRET`            | shared with `@grove/server-manager`, both directions, 32 bytes up        |
| `TICKET_PUBLIC_KEYS`      | the api's ticket keys, handed to every child verbatim                    |
| `SERVER_MANAGER_URL`      | where the beat goes, `https` in production                               |
| `GAME_MANAGER_URL`        | the data plane every child gets; this box holds it, not a join           |
| `HOST_ID`                 | the uuid the fleet knows this box by                                     |
| `HOST_REGION`             | which region it sits in                                                  |
| `MAX_INSTANCES`           | game processes this box may hold, `8` by default                         |
| `HEARTBEAT_INTERVAL`      | how often it beats, `10s` by default                                     |
| `INSTANCE_DRAIN_DEADLINE` | how long a redeployed world waits for its last player, `15m`             |
| `GAME_INSTANCE_BIN`       | the `grove-game-instance` binary it spawns                               |
| `INSTANCE_STATE_DIR`      | where it writes its children down, `/var/lib/grove` by default           |
| `BUNDLE_CACHE_DIR`        | one file per content hash, `/var/lib/grove/bundles` by default           |
| `GAME_UID` / `GAME_GID`   | who a child runs as, never this agent; required in production            |
| `CGROUP_ROOT`             | the cgroup v2 directory delegated to this agent; production only         |
| `CHILD_MEMORY_MAX_BYTES`  | one child's `memory.max`, `1 GiB` by default                             |
| `CHILD_PIDS_MAX`          | one child's `pids.max`, `256` by default                                 |
| `REAP_IDLE`               | how long an empty world lives past its boot grace, `5m`                  |
| `REAP_UNHEALTHY_PROBES`   | failed probes in a row that take a world down, `10`                      |
| `REAP_TOKEN_MARGIN`       | how long before its bearer dies a world drains, over the deadline, `30m` |
| `GROVE_ENV`               | `development`, `test` or `production`; the log level follows it          |

Every problem with that environment is reported in one error, so a box with three unset variables
does not need three restarts to learn that. Both listeners bind every interface, unlike the services
behind them; the firewall is what keeps the control port to the fleet's blocks and the router's.

A shutdown here leaves the children running. A game in progress outlives the agent that started it,
and a redeploy of this agent must not end anyone's session. Each child is written down under
`INSTANCE_STATE_DIR` as it starts, so the next run of this agent takes the survivors back rather
than coming up empty on a box that is already full. The record carries the revision each child
runs, so a survivor goes on being reported on its own version. A record that names none is a world
no joiner can be matched to: it is taken back draining, counted against the cap, and left off the
beat, whose router refuses an instance without a revision.

`pnpm run build | test | typecheck` at the repo root reach this module through `package.json`, whose
scripts shell to Go, and `typecheck` to `staticcheck` as well, a binary of its own that a machine
with the Go toolchain can still be without. Either one absent prints one `skipped:` line and
succeeds, so working on the TypeScript half of the fleet requires installing neither. CI names both
in `GROVE_REQUIRE_TOOLCHAIN`, where an absence is a broken install and fails the job instead.

The standard library and `@grove/go-grove`, and nothing else. Routing is `net/http` pattern
matching, so `go.sum` stays empty and the build works offline.
