# @grove/infra

The AWS deployment: the bucket every game lives in, the distribution in front of it, the tables shaped
for game data, and the EC2 fleet the sessions run on. Terraform. The Redis the task streams run on is
not provisioned here: the services that share it are handed it as `REDIS_URL`.

Two deployments, `staging` and `production`, built from one composing module. What differs between
them is the values each root passes (durability, replication, edge reach and the size of a box)
and nothing else, so a change to the shape of a deployment cannot land in one and be forgotten in
the other.

## Layout

| Path                      | Owns                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `modules/game-storage`    | the games bucket, the origin access control, and the distribution in front of it |
| `modules/game-data`       | the two tables `@grove/game-manager`'s store is keyed for                        |
| `modules/fleet-region`    | one region's network, role, launch template and group                            |
| `modules/environment`     | one whole deployment, composing the three above                                  |
| `environments/staging`    | the state key, the four providers, and staging's values                          |
| `environments/production` | the same three things, and production's                                          |

A root holds a backend, its providers and one module call. Everything a reader needs to know about
the shape of a deployment is in `modules/environment`, and everything that separates the two is in a
`terraform.tfvars` short enough to read in one screen.

## The bucket, and what the edge can reach

One bucket, keyed game first (every key a game owns begins `<game-id>/`) except an upload awaiting
inspection, and the bucket policy is what tells the classes apart.

| Key                                     | Holds                                  | Readable by                            |
| --------------------------------------- | -------------------------------------- | -------------------------------------- |
| `uploads/<game>/<path>`                 | an upload not yet inspected; expires   | no principal this configuration grants |
| `<game>/source/<path>`                  | what a creator writes                  | no principal this configuration grants |
| `<game>/manifests/<rev>-<saveId>.json`  | the set one save froze                 | no principal this configuration grants |
| `<game>/assets/<path>`                  | an inspected copy of an upload         | the distribution, and the fleet's role |
| `<game>/build/<taskId>/<sha256>/<name>` | what one build made, content-addressed | the distribution, and the fleet's role |

`cdn_prefixes` is a list of patterns relative to a game rather than of leading prefixes, and each is
rendered `<bucket>/<game-id>/<pattern>*` with the game id spelled as a uuid of `?` wildcards, so one
pattern covers every game without naming one and matches only the class directly beneath the game
(`*` would span slashes, and `*/build/*` reached a `source/build/` folder). `source/`, `manifests/`
and `uploads/` match none of them, which is what keeps a creator's code and an uninspected upload off
the edge. A creator's source is private
because a request for it through the edge is refused by S3, not because no URL for it was published.

Versioning is the history rather than a recovery window. A save overwrites a creator's file in place,
so the version id a manifest freezes is what makes every prior byte-set of every path still
addressable, and a delete leaves a marker rather than taking bytes an older manifest still names.
Lifecycle rules expire `uploads/` after `upload_retention_days` (1), expire a noncurrent version after
`noncurrent_version_retention_days` (30) along with the delete markers that leaves, and abort a
multipart upload left incomplete for a week.

CORS allows `GET`, `PUT` and `HEAD` from `browser_origins` alone, because an upload goes from the
browser straight to its quarantine key over a presigned PUT signed for its type and length. The variable has no default: a root has to name
the platform, editor and player origins before its first plan, and `docker/localstack` makes the
same rule for the three local dev servers.

Every grant here is a read. The configuration creates one role, the fleet box's, whose reads are
anchored to the game-id segment the same way, and nothing in it grants a write to any prefix, so an object arrives in this bucket under a principal held outside
this deployment.

ACLs are off (`BucketOwnerEnforced`), so what an object is readable by is the policy's answer alone
and an upload cannot widen it. The access-log bucket is the one exception, because CloudFront's
standard log delivery writes as its own canonical user and grants the owner nothing unless an ACL
says so.

Cached with CORS request and response policies attached, since a bundle is fetched cross-origin by the
player: build output under the managed `CachingOptimized` policy, never wrong because its key holds its
digest and it carries an immutable `Cache-Control`, and assets for `asset_cache_ttl_seconds` (60),
since a re-inspected path is rewritten in place.

## The task streams

A publish and an asset-carrying save each write a row in `@grove/api`'s database and push its id onto
a Redis stream, one stream per kind. What makes that queued work visible is the row; the message is
only what wakes a worker, and a sweeper re-announces anything unclaimed or whose lease ran out. That is why there
is no bucket notification here: an event is something you can only hope fired.

That Redis belongs to the platform the three services that touch it run on (`@grove/api`,
`@grove/game-builder` and `@grove/asset-upload-service`), and no fleet box is handed its address: a box
runs creator code, and the queue it would read is the work it is the target of.

## The tables

Two tables, keyed for the questions `@grove/game-manager` asks a datastore. That service keeps its
store in memory, and no role here is granted either table. `gameId` partitions both,
which puts the guarantee that service's scope makes at the datastore too: a row belonging to another
game is not in a partition a handler's token lets it name.

| Table     | Keys             | Shaped for                                                             |
| --------- | ---------------- | ---------------------------------------------------------------------- |
| `state`   | `gameId` / `key` | `Read`, `Write` and `Delete`; `revision` is the compare-and-set column |
| `bundles` | `gameId`         | the bundle set a game's sessions load                                  |

Production replicates both into every fleet region. A `@serverState` write sits inside a tick, and a
tick that crossed the continent to reach the store would spend its whole budget waiting.

## The fleet

Three boxes, one per region, in `us-east-1`, `us-west-2` and `us-east-2`. A region is the unit of
failure a player notices, and `@grove/server-manager` treats a requested region as a filter rather
than a preference: a region with no box in it is a region no player can be placed in.

Each region gets a network of its own, and the three blocks are distinct so any two of them can be
routed to each other later. The subnets are public: a player's client opens a WebSocket to its box
by name, and putting the boxes behind NAT would mean terminating every session at a load balancer,
which is the one thing the architecture keeps off the per-tick path. The box's own agent terminates
TLS on `player_port` and proxies each socket to the game process on loopback, so the security group
opens `player_port` to the internet and nothing else to it, and the agent's control port to the three
fleet blocks and `server_manager_cidrs` alone.

There is no key pair and no inbound SSH rule. An operator reaches a box through Session Manager,
which makes access an IAM decision that leaves a trail rather than a key someone still holds.

The group replaces a box on EC2 health alone, suspends `AZRebalance`, and has no instance refresh.
All three are the same fact: terminating a box ends every session it was holding, so a box is only
ever replaced when the machine itself is gone, and rolling a new launch template version out is an
operator's call made when the sessions on it can be drained.

The launch template's user data creates a `grove` system user owning `/var/lib/grove` and a
`grove-game` user every game process runs as, and installs a root-only script that reads the
parameters below from Parameter Store, writes the TLS pair to `/etc/grove/tls` (root:grove, 0640) and
the whole of `@grove/instance-manager`'s environment to `/etc/grove/instance-manager.env` at 0600. The
agent runs as `grove` under systemd with that script as `ExecStartPre=+`, so every start (a restart,
a reboot) reads them afresh, and holds only `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL` (to spawn and
signal `grove-game` processes, which it clears before each spawn) plus `CAP_NET_BIND_SERVICE` for
`player_port`, with `NoNewPrivileges` and `Delegate=yes`, the subtree each game's own cgroup is cut
from. `grove-imds-block` runs first and refuses `grove-game` any route to the instance metadata
service, so a game process can neither read the box's role nor its parameters; `grove-tls-refresh`
re-reads the TLS pair hourly, and `grove-cgroup-unstick` restarts an agent that died with game
cgroups still delegated. `KillMode=process`, because a redeploy of the agent must not end anyone's
session. `HOST_ID` is a uuid minted on first boot and kept at `/etc/grove/host-id`, so a restarted
agent keeps the identity the fleet knows it by, and each boot writes the A record
`<host-id>.<fleet_domain>` into `fleet_zone_id`: the name players and `@grove/server-manager` dial,
and the one the TLS certificate covers. The boxes reach `server_manager_url` and `game_manager_url`,
both `*.grove.internal` names, which resolve only where a private DNS zone and a route to those
services have been set up for the fleet VPCs.

The image is not a stock one. `fleet_ami_parameter` names an SSM parameter, which must exist in each
of the three fleet regions, holding the id of an AMI built from Amazon Linux 2023 with the AWS CLI,
curl and `iptables-nft` (user data installs the last with `dnf` when it is missing),
`/opt/grove/bin/instance-manager` (`go build ./apps/grove/instance-manager`, static) and
`/opt/grove/bin/grove-game-instance` (`cargo build --release --locked -p grove-game-instance` in
`apps/grove`, on a glibc no newer than the image's), and no `/etc/grove/host-id` of its own, which
would give every box launched from it the same identity. Publishing a new id to that parameter is a
new launch template version on the next plan.

## The box's parameters

Four live in Parameter Store, one copy per region because Parameter Store is regional, under
`/grove/<environment>/fleet/`: `FLEET_SECRET` and `TLS_KEY` as `SecureString`, `TLS_CERT` (Advanced
tier, for a chain's length) and `TICKET_PUBLIC_KEYS` as plain `String`, since a public key protects
nothing. No box holds a key that signs anything: tickets are verified against the api's public keys,
and a store bearer arrives with each world from `@grove/server-manager`. Terraform creates each
parameter and never its value: a secret passed as a variable is a secret in the state file and in
every plan output. Each is created holding `replace-me`, set out of band, and ignored here from then
on; a box picks a new value up on the agent's next restart, and a renewed TLS pair within the hour.

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
