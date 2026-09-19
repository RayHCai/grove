# @grove/infra

The AWS deployment: the bucket every game lives in, the distribution in front of it, the Redis the
fleet's queued work is announced on, the tables shaped for game data, and the EC2 fleet the sessions
run on. Terraform.

Two deployments, `staging` and `production`, built from one composing module. What differs between
them is the values each root passes — durability, replication, edge reach and the size of a box —
and nothing else, so a change to the shape of a deployment cannot land in one and be forgotten in
the other.

## Layout

| Path                      | Owns                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `modules/game-storage`    | the games bucket, the origin access control, and the distribution in front of it |
| `modules/task-streams`    | the Redis every queued task is announced on, and the network it sits in          |
| `modules/game-data`       | the two tables `@grove/game-manager`'s store is keyed for                        |
| `modules/fleet-region`    | one region's network, role, launch template and group                            |
| `modules/environment`     | one whole deployment, composing the four above                                   |
| `environments/staging`    | the state key, the four providers, and staging's values                          |
| `environments/production` | the same three things, and production's                                          |

A root holds a backend, its providers and one module call. Everything a reader needs to know about
the shape of a deployment is in `modules/environment`, and everything that separates the two is in a
`terraform.tfvars` short enough to read in one screen.

## The bucket, and what the edge can reach

One bucket, keyed game first — every key a game owns begins `<game-id>/` — and the bucket policy is
what tells the classes under that apart.

| Key                           | Holds                              | Readable by                            |
| ----------------------------- | ---------------------------------- | -------------------------------------- |
| `<game>/source/<path>`        | what a creator writes              | no principal this configuration grants |
| `<game>/manifests/<revision>` | the set one save froze             | no principal this configuration grants |
| `<game>/assets/<path>`        | what a game draws with             | the distribution, and the fleet        |
| `<game>/build/<revision>/`    | what a build of that manifest made | the distribution, and the fleet        |

`cdn_prefixes` is a list of patterns relative to a game rather than of leading prefixes, and each is
rendered `<bucket>/*/<pattern>*`. The wildcard is mid-string because the game comes first, so one
pattern covers every game's build output without naming one — and `source/` and `manifests/` match
none of them, which is what keeps a creator's code inside the fleet. A creator's source is private
because a request for it through the edge is refused by S3, not because no URL for it was published.

Versioning is the history rather than a recovery window. A save overwrites a creator's file in place,
so the version id a manifest freezes is what makes every prior byte-set of every path still
addressable, and a delete leaves a marker rather than taking bytes an older manifest still names.

Every grant here is a read. The configuration creates one role, the fleet box's, and nothing in it
grants a write to any prefix, so an object arrives in this bucket under a principal held outside
this deployment.

ACLs are off — `BucketOwnerEnforced` — so what an object is readable by is the policy's answer alone
and an upload cannot widen it. The access-log bucket is the one exception, because CloudFront's
standard log delivery writes as its own canonical user and grants the owner nothing unless an ACL
says so.

Cached under the managed `CachingOptimized` policy with CORS request and response policies attached:
a bundle is fetched cross-origin by the player, and an object under `build/` is immutable because the
revision naming it is, so a long cache is never wrong.

## The task streams

A publish and an asset-carrying save each write a row in `@grove/api`'s database and push its id onto
a Redis stream, one stream per kind. What makes that queued work visible is the row; the message is
only what wakes a worker, and a sweeper re-pushes anything still sitting unclaimed. That is why there
is no bucket notification here: an event is something you can only hope fired.

Serverless, because the load is a message per save and per publish — a sized node would be chosen for
a peak nobody can name yet, and this one carries no capacity decision at all. Encryption in transit
and at rest is not a setting on it; both are always on, which is half of why it is one.

The cache gets a network of its own. The three services that touch these streams — `@grove/api`,
`@grove/game-builder` and `@grove/asset-upload-service` — are not built by this configuration, and the one
thing that is, the game-instance fleet, must never reach them: a box running creator code that could
read the build stream could settle somebody else's build. `client_cidrs` is what opens it to the
blocks those services are deployed into, and an empty list leaves the cache reachable from nothing,
which is what an unwired deployment should be.

One alarm, on read latency with `breaching` on missing data: a cache that has stopped answering is
every save that lands an asset and every publish going unqueued, and nothing else here reports it.

## The tables

Two tables, keyed for the questions `@grove/game-manager` asks a datastore. `gameId` partitions both,
which puts the guarantee that service's scope makes at the datastore too: a row belonging to another
game is not in a partition a handler's token lets it name.

| Table     | Keys             | Shaped for                                                                  |
| --------- | ---------------- | --------------------------------------------------------------------------- |
| `state`   | `gameId` / `key` | `Read`, `Write` and `Leaderboard`; `revision` is the compare-and-set column |
| `bundles` | `gameId`         | `Bundles`                                                                   |

A board is a value under a key in `state` rather than a table of its own. Ordering it is then the
store's work and not the datastore's, and that is what the key schema buys: an index keyed on score
has to be partitioned by the board, a board id carries no `gameId`, and the isolation every other
row gets from the partition key would have held for a leaderboard only by convention.

What it costs is the item ceiling. A board is read and written whole, so it is bounded by DynamoDB's
400 KB item — a few thousand entries — and a score update rewrites all of them. The compare-and-set
on `revision` is what makes that safe rather than lossy: two ticks updating one board race on the
key like any other pair of writers, and the loser is told.

Production replicates both into every fleet region. A `@serverState` write sits inside a tick, and a
tick that crossed the continent to reach the store would spend its whole budget waiting.

## The fleet

Three boxes, one per region, in `us-east-1`, `us-west-2` and `us-east-2`. A region is the unit of
failure a player notices, and `@grove/server-manager` treats a requested region as a filter rather
than a preference — a region with no box in it is a region no player can be placed in.

Each region gets a network of its own, and the three blocks are distinct so any two of them can be
routed to each other later. The subnets are public: a player's client opens a WebSocket straight to
its game process, and putting the boxes behind NAT would mean terminating every session at a load
balancer, which is the one thing the architecture keeps off the per-tick path. The security group
opens the kernel's ephemeral range to the internet for that traffic, and the agent's own port to the
three fleet blocks alone — of which only the region's own is routable until two of them are peered.

There is no key pair and no inbound SSH rule. An operator reaches a box through Session Manager,
which makes access an IAM decision that leaves a trail rather than a key someone still holds.

The group replaces a box on EC2 health alone, suspends `AZRebalance`, and has no instance refresh.
All three are the same fact: terminating a box ends every session it was holding, so a box is only
ever replaced when the machine itself is gone, and rolling a new launch template version out is an
operator's call made when the sessions on it can be drained.

The launch template's user data resolves the whole of `@grove/instance-manager`'s environment and
writes it to `/etc/grove/instance-manager.env` at 0600, then starts the agent under systemd with
`KillMode=process` — a redeploy of the agent must not end anyone's session. `HOST_ID` is a uuid
minted on first boot and kept at `/etc/grove/host-id`, so a restarted agent keeps the identity the
fleet knows it by. The AMI is expected to carry `/opt/grove/bin/instance-manager` and
`/opt/grove/bin/grove-game-instance`, and to carry no `/etc/grove/host-id` of its own, which would
give every box launched from it the same identity.

## The two secrets

`FLEET_SECRET` and `GAME_TOKEN_SECRET` live in Parameter Store as `SecureString`, one copy per
region because Parameter Store is regional, under `/grove/<environment>/fleet/`. Terraform creates
the parameter and never its value: a secret passed as a variable is a secret in the state file and
in every plan output. Each is created holding `replace-me`, rotated in out of band, and ignored here
from then on.

## Running it

The state bucket is the one thing that cannot be created by the configuration that keeps its state
in it, so it is made once per account:

```bash
aws s3api create-bucket --bucket grove-terraform-state --region us-east-1
aws s3api put-bucket-versioning --bucket grove-terraform-state \
    --versioning-configuration Status=Enabled
```

Locking is `use_lockfile`, which puts the lock in that bucket beside the state, so there is no lock
table to provision before the first apply.

```bash
cd environments/staging
terraform init
terraform plan
terraform apply
```

`pnpm run typecheck | format | format:check` at the repo root reach this package through
`package.json`. `typecheck` initialises each root with `-backend=false` and validates it, so
checking that the configuration is well-formed needs neither a credential nor the state bucket.
With no Terraform on `PATH` they print one `skipped:` line and succeed, the same bargain the Go and
Rust packages strike.

## What it does not own

What runs on a box. Which box a session lands on is `@grove/server-manager`'s, and what a box does
with its processes is `@grove/instance-manager`'s. This package builds the machines, the buckets and
the tables those services are pointed at, and holds no opinion about any of them.
