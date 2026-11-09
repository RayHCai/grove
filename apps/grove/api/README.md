# @grove/api

The public HTTP surface for accounts, games, social and joining a game: every route, the gates in
front of it, and the ticket the allocator signs.

The only service a browser talks to over HTTP. It never sits on a per-tick path; a client dials its
game process directly, with a ticket this service signed. Sessions live in Postgres, so any number of
replicas answer any cookie and a deploy signs nobody out. Every write but the ones a
caller has no session for (signing up, signing in, and the two halves of a password reset) carries
the CSRF token in `x-csrf-token`, and `GET /v1/auth/session` hands another to a browser still
holding the cookie; a read carries nothing but the cookie. A write whose token is stale is a `403`
coded `csrf_invalid`, apart from `forbidden`, because re-reading the session mends it, which the shared
client in `@grove/api-contract/client` does once before giving up.

## The seams

The dependencies arrive in one object handed to `buildApp` rather than as handles a route reaches
for, so what stands behind each one is chosen where the process starts, and each scope is handed only
the seams it reads. Five are record seams, one per domain: `Accounts` (credentials, resets),
`Games` (ownership, visibility, the last publish), `Workspaces` (the file set and the save that moves
it), `Tasks` (queued work, its leases, what a build stored, the playable version) and `FleetHistory`.
`Sessions` is the store behind the cookie; `Fleet` answers where a joining player should dial and
takes a new version; `Storage` is the games bucket a creator's files and manifests live in;
`TaskQueue` announces a queued task on the stream the service that runs that kind reads, in that
kind's own Redis database, one connection per kind, since `SELECT` pins a connection to one; `Mailer`
carries a password reset link to an address; `Social` answers a viewer's friends and block list, and
is empty rather than refusing when unattached.

The save, the publish, the delete, the join, a worker's claim and settle, and a build's reads and
writes are application functions in `src/workflows/`, called with the seams they need and answering an
outcome a route turns into a status, so each is driven without HTTP.

`main.ts` reads the environment and attaches what it found: the record seams and `Sessions` are
Postgres through Prisma when `DATABASE_URL` names one (sessions held in the process otherwise),
`Storage` is S3 through the AWS SDK when `GAMES_BUCKET` names a bucket, and
`TaskQueue` is Redis when `REDIS_URL` names one, each the unattached seam otherwise. A production
process refuses to start without all three, and any other process logs once, at startup, which it
left unattached. `Mailer` is the
one seam chosen by `NODE_ENV` rather than by a URL: outside production it writes the reset link to
the log so the flow can be walked without a provider, and a deployed process has none until one is
attached here, because a link in a log is a delivered password reset to everyone who can read the log.

Outside production, a process pointed at nothing still starts and still serves: sign-in is `401` for every credential, every write into the store is a `501`, and every route behind
the cookie answers as though nobody holds an account, because the session those routes read is the
one a sign-in mints.

Behind that gate, a join asks the router for a placement (`409` when the fleet has no box to spare,
`500` when the router itself fails) and a publish writes a build task pinned to the manifest the
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
an account has exactly one credential and exactly one way to prove it, which is what makes the
forgotten-password path below the whole of account recovery rather than one branch of it.

`POST /v1/auth/password-resets` answers `202` whether or not the address has an account, because it
is unauthenticated and which addresses are registered is not its to tell. When one does, a 256-bit
key is minted and mailed as a link to the platform's own reset page; the table holds only its
SHA-256, so the rows cannot hand anybody in, and a partial unique index keeps at most one live key
per account: asking a thousand times leaves one door, not a thousand. One address is mailed at most
three times an hour, a fourth ask answering the same `202` and sending nothing, so the form is no way
to fill somebody's inbox. `PUT /v1/auth/password`
spends it, in the statement that finds it so two clicks cannot both land, and wrong, already-spent
and expired are one answer. Spending a key clears any lockout, because somebody resetting has
usually just locked themselves out guessing; it signs nobody in, and it ends every session the
account was holding; a reset is what a person does when they think the password was stolen.

Changing a password drops every other session the account was holding, and closing an account is
refused while it still owns a game: the bundles a game names live in S3
and its server state in `@grove/game-manager`, where no cascade in this database reaches them. Both re-authenticate first, and
the challenge is required rather than optional, because one a caller may decline by leaving a field
out is not a challenge.

`POST /v1/players` mints a session the way a sign-in does. Behind one, `GET`, `PATCH` and `DELETE`
on `/v1/players/me` read, rename and close the account, `PUT /v1/players/me/password` changes the
password and hands back the session it replaces, and `GET /v1/players/:playerId` is the same name
and id every other signed-in caller may read, and never the address. `POST /v1/games` makes one for whoever asked, and `GET /v1/games` lists what
they own, newest first, a page of up to a hundred (`?limit=`), each with `publishedAt`: the last
publish, or `null` for a game never published. A page with more after it names the next in an
`x-next-cursor` header, which `?cursor=` takes back; the body stays the array it always was.

A password is 8 to 128 characters. A display name and a game title are NFKC-folded and trimmed
before anything sees them, then held to 1–64 and 1–120, and both refuse control and
direction-override characters: a display name reaches creator-authored game code through every
leaderboard row, and a name that renders as something other than what it is belongs to nobody.

Five wrong passwords in a row lock an account, doubling from a second to a fifteen-minute ceiling,
and the count decays at that same ceiling; without the decay, one wrong guess every fifteen minutes
from one address keeps somebody out of their own account for good. The attempt is spent before the
hash is checked rather than counted after, so a burst of guesses queues on the row instead of every
request in it reading the same unlocked count. A failed re-authentication is counted the same way,
because the routes that demand one carry only the general budget below.

Every route but the fleet's and `/health` spends one budget of 1,200 requests a minute, counted in
each process and keyed on the session's player, and on the address only for a caller with none, so a classroom behind one school's
NAT is a budget per student, and opening the largest game the workspace allows (a read per file) sits
inside one. Signing in, signing up and asking for a reset spend a credential budget instead: 300 a
minute per address, counted before the body is read, which is about ten classes signing in behind one
NAT with a mistype each, and 10 a minute per address and folded email, so one student's typos cost
nobody else. `GET /v1/auth/session` and signing out are on the general budget, where an app loading
spends them.

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
it, and only those two.

The player origin is the one place a credential genuinely crosses sites, and what crosses there is
not this session: it is the ticket the allocator signs, scoped to one game, one player and a few
minutes. A capability rather than an identity, because a credential that has to travel should buy
the least it can.

A session is a row in Postgres found by the SHA-256 of its id, so a read of the table opens nothing.
Only a sign-in inserts one; every request after it updates the row it names and never creates one, so
a request still in flight when a session is revoked has nothing to write it back into, and a
revocation needs no record of its own. Expired rows are refused on read and pruned hourly.

## The workspace

A game is a set of files in one bucket, keyed game first: `<gameId>/source/<path>` for what a creator
writes, `<gameId>/assets/<path>` for the inspected copies of the binaries, `<gameId>/manifests/` for
the snapshots, `<gameId>/build/<taskId>/` for what a build produces; an upload waits in quarantine at
`uploads/<gameId>/<path>`, a prefix of its own so one lifecycle rule expires it a day on. `GameFile`
is one row per path naming the version the bucket minted for the bytes at it. A key is overwritten in
place and bucket versioning keeps a replaced byte-set addressable for thirty days, so the manifests
are the history over that window: each is written once, names every path the game held at that
instant and the exact version at it, and is what a build pins to.

`manifests/` and `build/` are siblings rather than one inside the other, because they sit on
opposite sides of the compiler: a manifest is a build's **input** and is written by the save, where
a build's output is written by the build. Most revisions have the first and no second (a creator
saves fifty times and publishes twice) and a manifest the build produced could only name whatever
was current when a box got round to the job, which is the race pinning a build to a revision exists
to close. What came out is named by the `BuildManifest` a worker settles its build with: the version,
the bundle set, and the `projectId`/`projectHash` a joiner has to claim. The row holds it, because the
allocator reads it on the path of every join and a bucket round trip does not belong there, and it is
accepted only when every address and digest in it names an output this service stored for that task.

`PUT /v1/games/:gameId/workspace` is the save, and it carries what **changed**: the text of each
source written to, the path of each asset uploaded beside it, and the paths removed. A path it never
mentions is one nobody touched. It names `baseRevision`, and the statement that checks that also
claims the next revision, so a second editor holding the same base is told `409` rather than
quietly overwriting the first. Every byte goes to the bucket first, the manifest included, under a
key naming this save (`<gameId>/manifests/<revision>-<saveId>.json`), and only then does one
transaction claim the revision, write the rows and record the save whose manifest froze it, so no row
lock waits on the bucket. A save that loses the race takes back every version it wrote, by version, so
the winner's is current at each key again; one whose rows would not come to equal its manifest is
rolled back as stale. A save is refused before a byte is written once its base is already behind.

An asset's bytes never pass through here. `POST /v1/games/:gameId/assets` takes the path, one of the
media types the contract allows, and the length, and answers a PUT into quarantine presigned for that
type and that length (a length past 32 MiB is a `413`) with the headers it must carry, recording
nothing: a ticket the editor never used must not leave a row behind. The save that names the path
afterwards reads back from quarantine what actually landed, so the version and the length are facts
rather than the editor's claim; an asset named and never uploaded is a `400` saying which, and one
the row already holds is no change. In the same transaction that bumps the revision, each asset
earns an `ASSET_UPLOAD` task pinned to the revision and the upload version that landed it, and any
inspection still live for a path the save replaces or removes is cancelled; a save of source alone
creates none. The asset service's claim hands it a presigned GET of that upload version and a
presigned PUT to `<gameId>/assets/<path>`, both expiring with its lease. Its success names the version
the copy landed as, which is checked to exist at the upload's length before `GameFile` records it:
`validatedVersionId` becomes the upload version and `edgeVersionId` the copy, written only while the
row still holds that upload, so a save that replaced the bytes leaves the row unvalidated. A copy no
row ends up naming is deleted by version, so a superseded worker never leaves the edge serving it.

`GET /v1/games/:gameId/files/*` streams one file back at the version the rows name (an inspected
asset from its edge copy, an uninspected one from quarantine), which is how an editor reads a game it
did not just write: what this game holds is what it may read.

`POST /v1/games/:gameId/versions` publishes what is saved. It carries no body: the manifest is
already frozen, so the route writes a `BUILD` task pinned to that revision and the save that froze it,
and pushes its id onto a stream. Revision zero is a `409`: there is a manifest to build only once one
save has happened. So is a game holding an asset whose verification has not reached the bytes it
holds, checked with the game row locked so the verdicts read are that revision's, and the refusal
names the paths: a published build is what every browser and game box joining the game loads, and
it may not pin bytes nothing has looked at. A second publish of a manifest already queued gets
the first task back rather than a second build of identical bytes.

`PATCH /v1/games/:gameId` is where a creator says who may reach their game: `private`, `unlisted` or
`public`. A game is created private, because a world nobody has finished must not become playable by
the act of compiling successfully; publishing does not make a game reachable and neither does
building it, and this is the only write that does.

`DELETE /v1/games/:gameId` erases every version and delete marker under the game's `<gameId>/`
prefix and its `uploads/<gameId>/` quarantine, then drops the row, whose cascade takes its files and
tasks. The bucket goes first, so an erase that fails (`502`) leaves a game its owner can delete again.
The game's server state lives in `@grove/game-manager`, which neither step reaches.

## Playing

`POST /v1/games/:gameId/play` is the hot path into a game, and the only route that mints a
game-scoped token: a join ticket signed with Ed25519 under `TICKET_SIGNING_KEY`, carrying a random
`jti` so two minted in one second differ, verified on a box holding only the public half. It is the
one game-scoped route somebody who does not own the game is supposed to
reach, so `requireGameOwner` is absent and the game's own visibility stands in its place. A private
game somebody else owns is answered exactly as a game that is not there: a `403` on the first would
confirm the id names a real game to anybody who guessed one.

What it sends a player at is the newest build that **finished**, never the newest publish: a
revision that failed to compile, or is still compiling, is one no box can be asked to run, and a
game that has never had one is a `409`. That version travels the whole way down: the placement call
names it so the fleet joins a world running that code rather than one still draining on the version
before it, and the answer carries back the `projectId` and `projectHash` a joiner has to claim,
without which the handshake refuses it before a `Player` exists. No bundle refs go with them: what
code to run is the `Welcome`'s to name, and the session verifies those bytes itself, so a second
copy here would be this service's guess at what the world a player landed in is running. A placement
that came back on another version is refused here as a fleet fault: it would mean naming an identity
the world it placed does not hold, and a joiner declaring the wrong one is turned away at the
handshake.

## Tasks

One table for every piece of queued work the fleet does, discriminated by `kind`: a build and an
asset upload have the same life (claimed, attempted, settled, swept) and two tables would mean two
sweepers and two sets of transition rules. Every task is pinned to a `manifestRevision`, which is
what stops a build picking up edits made after the button was pressed.

The row is written before the message is pushed, always. A push that was lost is work the sweeper
still finds: every `TASK_SWEEP_INTERVAL_MS` it re-announces, once per `TASK_SWEEP_AFTER_MS`, each task
nothing has announced since then that is unclaimed or whose claim's lease ran out, which is also what
recovers a claim whose stream entry a trim took. A message nothing ever wrote down is work nobody
can. One stream per kind, read with a consumer group by `@grove/game-builder` and
`@grove/asset-upload-service`: one stream would make each skip the other's messages, and a group is
what hands a dead worker's claim back.

A claim is a lease: it takes a task that is unclaimed, or one whose lease ran out, records which
worker holds it (`x-grove-worker`, the credential's name without one) and until when, and counts an
attempt. A claim while another's lease is live is a `409` that counts nothing, so a redelivered
message is acknowledged rather than becoming an attempt. Each kind's lease (`BUILD_LEASE_MS`,
`ASSET_UPLOAD_LEASE_MS`) is shorter than its worker's reclaim window, so a dead worker's redelivery
finds the task free. A claim nobody came back to for three lease windows is failed by the sweeper.

`PATCH /v1/tasks/:taskId` is where a worker says what it did, behind its own secret rather than a
session: `BUILDER_SECRET` answers for builds and `ASSET_SERVICE_SECRET` for uploads, and a task of
the other kind is a `404` to it. The transitions are monotonic: `NOT_STARTED` to `IN_PROGRESS` to a
terminal state, never backwards, so a redelivered attempt that tries to walk a settled task back is a
`409` rather than an outcome overwritten. A success this service cannot confirm is recorded as a
failure and answered `409`. A build's success that is the newest playable version is posted to
`@grove/server-manager` as a deployment, best effort, so worlds on other versions drain. A creator's editor reads its own through
`GET /v1/games/:gameId/tasks/:taskId`, which is scoped to the game the way every other creator-facing
route is: a task id alone says nothing about who queued it.

## What a build box may reach

`@grove/game-builder` holds no bucket credential, so every byte it touches goes through three routes
behind `BUILDER_SECRET`, each scoped to one build task and answering only while that task is claimed:
the secret reaches no game nobody asked it to build. `GET /v1/fleet/tasks/:taskId/manifest` hands
back the snapshot the task's save froze, parsed once and held, since a manifest key is written once;
`.../files/*` hands back one source at the version **that manifest** named, never what is current at
the key, so an edit made after the publish cannot reach a compiler; and
`PUT /v1/fleet/tasks/:taskId/build/:name` stores one flat name at
`build/<taskId>/<sha256>/<name>`, content-addressed so no rebuild or second attempt changes bytes a
success already names, under a year-long immutable `Cache-Control`, as `text/javascript` or
`application/json` by its name and never by the type a worker sent. A name is one segment, so no
spelling of it reaches a key outside the task's prefix. A bucket that did not answer is a `503`
rather than a `404`, so a builder retries instead of failing a creator's build, and the fleet routes
sit outside the browser rate limit, which a few workers behind one address would otherwise share.

The address in the answer is computed here from `GAMES_CDN_URL` and the digest is taken of the bytes
that landed, because both are what a joining browser is later held to: a worker that supplied its
own would be choosing where the code a player runs comes from. Bodies in that scope are bytes and
never values (the JSON parser is overridden along with the rest), since a JSON output parsed and
re-serialised here would be stored under a hash that is not the one it was written as.

## The fleet's history

`POST /v1/fleet/reports` is where `@grove/server-manager` leaves what the fleet did, behind
`SERVER_MANAGER_SECRET`, the one this service presents to it for placements and deployments. That
service routes off a registry one interval of
heartbeats rebuilds, which is what lets it hold the fleet in memory, and what means the state a box
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
`API_PORT` are the two conveniences that carry one, and a platform-assigned `PORT` is the fallback
for the second.

| Variable                 | What                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`               | `development`, `test` or `production`; sets the log level and the cookie's `secure` flag                                                                                                                         |
| `DATABASE_URL`           | the Postgres holding accounts and games; required in production, and absent elsewhere the records seam stays unattached and every route behind it answers as it does above                                       |
| `API_HOST`               | address to bind, `0.0.0.0` by default                                                                                                                                                                            |
| `API_PORT`               | `4000` by default                                                                                                                                                                                                |
| `PORT`                   | set by a platform such as Railway; the fallback for `API_PORT`                                                                                                                                                   |
| `SESSION_SECRET`         | signs the browser session cookie, at least 32 characters                                                                                                                                                         |
| `TICKET_SIGNING_KEY`     | the Ed25519 seed join tickets are signed with, 32 bytes of unpadded base64url; a box verifying them holds only its public half                                                                                   |
| `SERVER_MANAGER_SECRET`  | gates the router both ways: what this service presents for placements and deployments, and what a fleet report must carry                                                                                        |
| `BUILDER_SECRET`         | what a builder presents to claim and settle a build, read its source and store its output                                                                                                                        |
| `ASSET_SERVICE_SECRET`   | what the asset service presents to claim and settle an upload, and nothing else; each of these four is at least 32 characters and none may equal another                                                         |
| `SERVER_MANAGER_URL`     | where a placement is asked for, once per join, and a new version is posted                                                                                                                                       |
| `GAMES_BUCKET`           | the bucket every game's files, manifests and build output live in; required in production, and absent elsewhere a save says it has nowhere to put a file                                                         |
| `GAMES_CDN_URL`          | where the edge serves that bucket from, which is what a build's output is addressed by; only a game's `build/` and `assets/` are reachable through it                                                            |
| `AWS_REGION`             | the bucket's region, `us-east-1` by default                                                                                                                                                                      |
| `S3_ENDPOINT`            | set only where something other than AWS answers for the bucket, such as a local LocalStack                                                                                                                       |
| `ASSET_UPLOAD_TTL_S`     | how long an asset's presigned PUT is good for, 15 minutes by default                                                                                                                                             |
| `REDIS_URL`              | where a queued task is announced, in the database its kind names; required in production, and absent elsewhere the row is still written and no worker is ever told                                               |
| `TASK_SWEEP_INTERVAL_MS` | how often the sweeper looks for work nothing was told about, 30 seconds by default                                                                                                                               |
| `TASK_SWEEP_AFTER_MS`    | how long a task may go unannounced before its push is assumed lost and made again, 60 seconds by default                                                                                                         |
| `BUILD_LEASE_MS`         | how long a build's claim keeps it from every other builder, 150 seconds by default, under the builder's 180-second reclaim window                                                                                |
| `ASSET_UPLOAD_LEASE_MS`  | the same for an upload's inspection, 240 seconds by default, under the asset service's 300-second reclaim window                                                                                                 |
| `TRUSTED_PROXIES`        | comma-separated peers whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed: addresses, CIDR blocks, `loopback` or `uniquelocal`; one that does not name the real peer leaves the production cookie unset |
| `PLATFORM_ORIGIN`        | an origin allowed to send credentials                                                                                                                                                                            |
| `EDITOR_ORIGIN`          | the other one                                                                                                                                                                                                    |

The player origin is deliberately absent from that pair: it runs creator code and never calls this
service, so letting it send credentials would be handing them away.
