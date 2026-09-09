# @grove/infra

The AWS deployment: the bucket every game is published into, the distribution that serves it, the
tables behind game data, the listener that turns an upload into a build, and the EC2 fleet the
sessions run on. Terraform.

Two deployments, `staging` and `production`, built from one composing module. What differs between
them is the values each root passes — durability, replication, edge reach and the size of a box —
and nothing else, so a change to the shape of a deployment cannot land in one and be forgotten in
the other.

## Layout

| Path                      | Owns                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `modules/game-storage`    | the games bucket, the origin access control, and the distribution in front of it |
| `modules/upload-events`   | the rule that matches a source upload, and the queue a build is claimed from     |
| `modules/game-data`       | the three tables `@grove/game-manager` reads and writes                          |
| `modules/fleet-region`    | one region's network, role, launch template and group                            |
| `modules/environment`     | one whole deployment, composing the four above                                   |
| `environments/staging`    | the state key, the four providers, and staging's values                          |
| `environments/production` | the same three things, and production's                                          |

A root holds a backend, its providers and one module call. Everything a reader needs to know about
the shape of a deployment is in `modules/environment`, and everything that separates the two is in a
`terraform.tfvars` short enough to read in one screen.

## The bucket, and what the edge can reach

One bucket, three prefixes, and the bucket policy is what tells them apart.

| Prefix     | Holds                         | Reachable from                         |
| ---------- | ----------------------------- | -------------------------------------- |
| `sources/` | the archives a build compiles | the fleet's own role, and nothing else |
| `bundles/` | the artifacts a session loads | the distribution, and the fleet        |
| `assets/`  | what a game draws with        | the distribution, and the fleet        |

The distribution reads through an origin access control, and the policy grants it `s3:GetObject`
only under the two public prefixes. A creator's source is private because a request for it through
the edge is refused by S3, not because no URL for it was published.

ACLs are off — `BucketOwnerEnforced` — so what an object is readable by is the policy's answer alone
and an upload cannot widen it. The access-log bucket is the one exception, because CloudFront's
standard log delivery writes as its own canonical user and grants the owner nothing unless an ACL
says so.

Cached under the managed `CachingOptimized` policy with CORS request and response policies attached:
a bundle is fetched cross-origin by the player, and an object is named by the hash of its own bytes,
so a name can never come to mean different bytes and a long cache is never wrong.

## The listener

Object events go to the default event bus, and one rule matches `Object Created` under `sources/`
and puts it on a queue. That rule is the only thing that queues a build — a client that uploaded and
forgot to ask would otherwise leave a game published and never compiled.

The queue's visibility timeout is fifteen minutes because a compile is minutes of CPU across a child
`tsc` and a bundler, and a build reclaimed at thirty seconds is a build running twice. Three failed
deliveries move it to the dead-letter queue, where one message is one game that was published and
never built — which is what the alarm on that queue's depth reports.

## The tables

Three tables, `gameId` the partition key of every one of them, which puts the guarantee
`@grove/game-manager`'s scope makes at the datastore too: a row belonging to another game is not in
a partition a handler's token lets it name.

| Table          | Keys                   | Behind                                                       |
| -------------- | ---------------------- | ------------------------------------------------------------ |
| `state`        | `gameId` / `key`       | `Read` and `Write`; `revision` is the compare-and-set column |
| `leaderboards` | `boardId` / `playerId` | `Leaderboard`, ordered by the `by-score` local index         |
| `bundles`      | `gameId`               | `Bundles`                                                    |

A board's ranking is read only within its own partition, so the score index is local rather than
global: a global one would be a second, eventually-consistent copy of a page that has to be ordered
correctly the first time. A page is one descending query, and its `LastEvaluatedKey` is the cursor
the store mints.

Production replicates all three into every fleet region. A `@serverState` write sits inside a tick,
and a tick that crossed the continent to reach the store would spend its whole budget waiting.

## The fleet

Three boxes, one per region, in `us-east-1`, `us-west-2` and `us-east-2`. A region is the unit of
failure a player notices, and `@grove/server-manager` treats a requested region as a filter rather
than a preference — a region with no box in it is a region no player can be placed in.

Each region gets a network of its own, and the three blocks are distinct so any two of them can be
routed to each other later. The subnets are public: a player's client opens a WebSocket straight to
its game process, and putting the boxes behind NAT would mean terminating every session at a load
balancer, which is the one thing the architecture keeps off the per-tick path. The security group
opens the kernel's ephemeral range to the internet for that traffic, and the agent's own port only
to the fleet's blocks and the control plane's.

There is no key pair and no inbound SSH rule. An operator reaches a box through Session Manager,
which makes access an IAM decision that leaves a trail rather than a key someone still holds.

The group replaces a box on EC2 health alone, suspends `AZRebalance`, and has no instance refresh.
All three are the same fact: terminating a box ends every session it was holding, so a box is only
ever replaced when the machine itself is gone, and rolling a new launch template version out is an
operator's call made when the sessions on it can be drained.

The launch template's user data resolves the whole of `@grove/instance-manager`'s environment and
writes it to `/etc/grove/instance-manager.env` at 0600, then starts the agent under systemd with
`KillMode=process` — a redeploy of the agent must not end anyone's session. `HOST_ID` is the box's
own instance id, read from IMDSv2. The AMI is expected to carry `/opt/grove/bin/instance-manager`
and `/opt/grove/bin/grove-game-instance`.

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

What runs on a box. Which box a session lands on is `@grove/server-manager`'s, what a box does with
its processes is `@grove/instance-manager`'s, and the bytes under a prefix are
`@grove/upload-service`'s. This package builds the machines, the buckets and the tables those
services are pointed at, and holds no opinion about any of them.
