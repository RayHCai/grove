# @grove/api

The public HTTP surface for accounts, games, social and joining a game: every route, the gates in
front of it, and the ticket the allocator signs.

The only service a browser talks to over HTTP. It never sits on a per-tick path — a client dials its
game process directly, with a ticket this service signed. Sessions live in the process that minted
them, so it runs as one replica: a second would not recognise the first's cookie. Every write but the ones a
caller has no session for — signing up, signing in, and the two halves of a password reset — carries
the CSRF token in `x-csrf-token`, and `GET /v1/auth/session` hands another to a browser still
holding the cookie; a read carries nothing but the cookie.

## The seams

Five dependencies arrive as arguments to `buildApp` rather than as handles a route reaches for, so
what stands behind each one is chosen where the process starts. `Records` answers which account a
credential names, who owns a game, what is in that game's workspace, what is queued for it, and every
write that makes any of it true; `Fleet` answers where a joining player should dial; `Storage` is the
games bucket a creator's files and manifests live in; `TaskQueue` announces a queued task on the
stream the service that runs that kind reads; `Mailer` carries a password reset link to an address.

`main.ts` reads the environment and attaches what it found: `Records` is Postgres through Prisma when
`DATABASE_URL` names one, `Storage` is S3 through the AWS SDK when `GAMES_BUCKET` names a bucket, and
`TaskQueue` is Redis when `REDIS_URL` names one — each the unattached seam otherwise. `Mailer` is the
one seam chosen by `NODE_ENV` rather than by a URL — outside production it writes the reset link to
the log so the flow can be walked without a provider, and a deployed process has none until one is
attached here, because a link in a log is a delivered password reset to everyone who can read the log.

A process pointed at nothing still starts and still serves — sign-in is `401` for every credential, every write into the store is a `501`, and every route behind
the cookie answers as though nobody holds an account, because the session those routes read is the
one a sign-in mints.

Behind that gate, a join asks the router for a placement — `409` when the fleet has no box to spare,
`500` when the router itself fails — and a publish writes a build task pinned to the manifest the
last save froze and answers `202` carrying it; against the unattached records seam it answers `501`
rather than a task id nothing will report on. An ownership check against the unattached records seam
is a `403`, `GET /v1/games/:gameId/versions/latest` is a `404` for every game, and
`GET /v1/social/friends` the empty list.

## Accounts

An account's primary key **is** the `PlayerId` the rest of the fleet already names a person by, so
nothing has to translate between a person and a player. The password hash lives in a table of its
own, which is what makes reading an account unable to carry it into a response, and a row there is
argon2id or the database refuses it. An address is folded before it is stored and before it is
looked up, because every rule below is a statement about _the_ account holding an address.

An address and a password are the only way in. There is no second provider and no identity table, so
an account has exactly one credential and exactly one way to prove it — which is what makes the
forgotten-password path below the whole of account recovery rather than one branch of it.

`POST /v1/auth/password-resets` answers `202` whether or not the address has an account, because it
is unauthenticated and which addresses are registered is not its to tell. When one does, a 256-bit
key is minted and mailed as a link to the platform's own reset page; the table holds only its
SHA-256, so the rows cannot hand anybody in, and a partial unique index keeps at most one live key
per account — asking a thousand times leaves one door, not a thousand. `PUT /v1/auth/password`
spends it, in the statement that finds it so two clicks cannot both land, and wrong, already-spent
and expired are one answer. Spending a key clears any lockout, because somebody resetting has
usually just locked themselves out guessing; it signs nobody in, and it ends every session the
account was holding — a reset is what a person does when they think the password was stolen.

Changing a password drops every other session the account was holding, and closing an account is
refused while it still owns a game: the bundles, leaderboard rows and server state a game names live
in S3 and DynamoDB, where no cascade in this database reaches them. Both re-authenticate first, and
the challenge is required rather than optional, because one a caller may decline by leaving a field
out is not a challenge.

`POST /v1/players` mints a session the way a sign-in does. Behind one, `GET`, `PATCH` and `DELETE`
on `/v1/players/me` read, rename and close the account, `PUT /v1/players/me/password` changes the
password and hands back the session it replaces, and `GET /v1/players/:playerId` is the same name
and id every other signed-in caller may read, and never the address. `POST /v1/games` makes one for whoever asked, and `GET /v1/games` lists what
they own, newest first, up to a hundred.

A password is 12 to 128 characters. A display name and a game title are NFKC-folded and trimmed
before anything sees them, then held to 1–64 and 1–120, and both refuse control and
direction-override characters: a display name reaches creator-authored game code through every
leaderboard row, and a name that renders as something other than what it is belongs to nobody.

Five wrong passwords in a row lock an account, doubling from a second to a fifteen-minute ceiling,
and the count decays at that same ceiling — without the decay, one wrong guess every fifteen minutes
from one address keeps somebody out of their own account for good. The attempt is spent before the
hash is checked rather than counted after, so a burst of guesses queues on the row instead of every
request in it reading the same unlocked count. A failed re-authentication is counted the same way,
because the routes that demand one carry no rate limit of their own.

A deployed process runs `pnpm db:deploy` before it serves; `prisma db push` is not a path this
schema takes, because the CHECK constraints that refuse an unfolded address and a hash that is not
argon2id live only in the migrations.

## One session, three origins

The cookie this service sets is host-only on **its own** origin, `HttpOnly`, `SameSite=Lax`, and
`Secure` once deployed. The platform and the editor are two subdomains of one registrable domain, so
a request from either to here is same-site and the browser carries the cookie by itself. Nothing is
handed between them: each asks `GET /v1/auth/session` and this service answers, and the CSRF token
that comes back with it is minted per caller from the secret the session already holds.

No `Domain=` attribute, deliberately. Widening the cookie to the parent domain would hand it to every
subdomain there will ever be, and the CORS allowlist above already reaches the two that should have
it — and only those two.

The player origin is the one place a credential genuinely crosses sites, and what crosses there is
not this session: it is the ticket the allocator signs, scoped to one game, one player and a few
minutes. A capability rather than an identity, because a credential that has to travel should buy
the least it can.

## The workspace

A game is a set of files in one bucket, keyed game first: `<gameId>/source/<path>` for what a creator
writes, `<gameId>/assets/<path>` for the binaries, `<gameId>/manifests/<revision>.json` for the
snapshots, `<gameId>/build/<revision>/` for what a build produces. `GameFile` is one row per path
naming the version the bucket minted for the bytes at it. A key is overwritten in place and bucket
versioning keeps every prior byte-set addressable, so the manifests are the history: each is written
once, names every path the game held at that instant and the exact version at it, and is what a
build pins to and a rollback points at.

`PUT /v1/games/:gameId/workspace` is the save, and it carries what **changed**: the text of each
source written to, the path of each asset uploaded beside it, and the paths removed. A path it never
mentions is one nobody touched. It names `baseRevision`, and the statement that checks that also
claims the next revision — so a second editor holding the same base is told `409` rather than
quietly overwriting the first. The manifest is written from inside that same transaction: a manifest
the bucket refused rolls the whole save back, because a revision nothing can be rolled back to is
worse than a save that did not happen.

An asset's bytes never pass through here. `POST /v1/games/:gameId/assets` answers a presigned PUT and
records nothing — a ticket the editor never used must not leave a row behind — and the save that
names the path afterwards reads back from the bucket what actually landed, so the version and the
length are facts rather than the editor's claim. An asset named and never uploaded is a `400` saying
which. In the same transaction that bumps the revision, each asset earns an `ASSET_UPLOAD` task
pinned to the revision that landed it; a save of source alone creates none.

`GET /v1/games/:gameId/files/*` hands one file back at the version the rows name, which is how an
editor reads a game it did not just write: what this game holds is what it may read.

`POST /v1/games/:gameId/versions` publishes what is saved. It carries no body: the manifest is
already frozen, so the route writes a `BUILD` task pinned to that revision and pushes its id onto a
stream. Revision zero is a `409` — there is a manifest to build only once one save has happened. A
second publish of a manifest already queued gets the first task back rather than a second build of
identical bytes.

`PATCH /v1/games/:gameId` is where a creator says who may reach their game: `private`, `unlisted` or
`public`. A game is created private, because a world nobody has finished must not become playable by
the act of compiling successfully — publishing does not make a game reachable and neither does
building it, and this is the only write that does.

## Playing

`POST /v1/games/:gameId/play` is the hot path into a game, and the only route that mints a
game-scoped token. It is the one game-scoped route somebody who does not own the game is supposed to
reach, so `requireGameOwner` is absent and the game's own visibility stands in its place. A private
game somebody else owns is answered exactly as a game that is not there: a `403` on the first would
confirm the id names a real game to anybody who guessed one.

What it sends a player at is the newest build that **finished**, never the newest publish — a
revision that failed to compile, or is still compiling, is one no box can be asked to run, and a
game that has never had one is a `409`. That version travels the whole way down: the placement call
names it so the fleet joins a world running that code rather than one still draining on the version
before it, and the answer carries it back beside the bundle set, so the browser fetches the half it
needs rather than whatever this service built most recently. A placement that came back on another
version is refused here as a fleet fault — a browser handed the wrong bundle set is refused at the
handshake and, where it declared no hash, admitted into a world holding none of its own scripts.

## Tasks

One table for every piece of queued work the fleet does, discriminated by `kind`: a build and an
asset upload have the same life — claimed, attempted, settled, swept — and two tables would mean two
sweepers and two sets of transition rules. Every task is pinned to a `manifestRevision`, which is
what stops a build picking up edits made after the button was pressed.

The row is written before the message is pushed, always. A push that was lost is work the sweeper
still finds — it re-announces anything sitting unclaimed past `TASK_SWEEP_AFTER_MS` — where a
message nothing ever wrote down is work nobody can. One stream per kind, read with a consumer group
by `@grove/game-builder` and `@grove/asset-upload-service`: one stream would make each skip the other's
messages, and a group is what hands a dead worker's claim back.

`PATCH /v1/tasks/:taskId` is where a worker says what it did, behind the fleet bearer rather than a
session. The transitions are monotonic — `NOT_STARTED` to `IN_PROGRESS` to a terminal state, never
backwards — so a redelivered attempt that tries to walk a settled task back is a `409` rather than an
outcome overwritten. A creator's editor reads its own through
`GET /v1/games/:gameId/tasks/:taskId`, which is scoped to the game the way every other creator-facing
route is: a task id alone says nothing about who queued it.

## The fleet's history

`POST /v1/fleet/reports` is where `@grove/server-manager` leaves what the fleet did, behind the same
fleet bearer a worker settles a task with. That service routes off a registry one interval of
heartbeats rebuilds, which is what lets it hold the fleet in memory — and what means the state a box
_was_ in survives nowhere else. A box that failed at 3am leaves no mark on any later beat.

Each report carries the whole fleet and every transition since the last one that was acknowledged.
The hosts are a snapshot and replace what is held; the events are append-only and keyed by an id the
router minted, so a report retried after a failed write lands on the rows it already wrote rather
than a second copy of them. Both land in one transaction, because a snapshot its own events
contradict is a fleet nobody can read back.

Nothing reads any of it back on a request path. A report arriving late, twice, or not at all costs
the history and never a join.

## The environment

Nothing that decides a secret or a cookie flag has a default: this is the one service on the public
internet, and a value that fell back to something would be a choice nobody made. `API_HOST` and
`API_PORT` are the two conveniences that carry one.

| Variable                 | What                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`               | `development`, `test` or `production`; sets the log level and the cookie's `secure` flag                                                                                                                          |
| `DATABASE_URL`           | the Postgres holding accounts and games; absent, the records seam stays unattached and every route behind it answers as it does above                                                                             |
| `API_HOST`               | address to bind, `0.0.0.0` by default                                                                                                                                                                             |
| `API_PORT`               | `4000` by default                                                                                                                                                                                                 |
| `SESSION_SECRET`         | signs the browser session cookie, at least 32 characters                                                                                                                                                          |
| `GAME_TOKEN_SECRET`      | signs the game-scoped tokens the allocator mints — a different key, a different blast radius                                                                                                                      |
| `FLEET_SECRET`           | the bearer this service presents to the fleet's own services, at least 32 characters — a third key, a third blast radius                                                                                          |
| `SERVER_MANAGER_URL`     | where a placement is asked for, once per join                                                                                                                                                                     |
| `GAMES_BUCKET`           | the bucket every game's files, manifests and build output live in; absent, a save says it has nowhere to put a file                                                                                               |
| `AWS_REGION`             | the bucket's region, `us-east-1` by default                                                                                                                                                                       |
| `S3_ENDPOINT`            | set only where something other than AWS answers for the bucket, such as a local MinIO                                                                                                                             |
| `ASSET_UPLOAD_TTL_S`     | how long an asset's presigned PUT is good for, 15 minutes by default                                                                                                                                              |
| `REDIS_URL`              | where a queued task is announced; absent, the row is still written and the sweeper is what re-announces it                                                                                                        |
| `TASK_SWEEP_INTERVAL_MS` | how often the sweeper looks for work nothing was told about, 30 seconds by default                                                                                                                                |
| `TASK_SWEEP_AFTER_MS`    | how long a task may sit unclaimed before its push is assumed lost, 60 seconds by default                                                                                                                          |
| `TRUSTED_PROXIES`        | comma-separated peers whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed: addresses, CIDR blocks, `loopback` or `uniquelocal` — one that does not name the real peer leaves the production cookie unset |
| `PLATFORM_ORIGIN`        | an origin allowed to send credentials                                                                                                                                                                             |
| `EDITOR_ORIGIN`          | the other one                                                                                                                                                                                                     |

The player origin is deliberately absent from that pair: it runs creator code and never calls this
service, so letting it send credentials would be handing them away.
