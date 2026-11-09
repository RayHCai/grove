# @grove/asset-upload-service

The worker that inspects every asset a creator uploads before the CDN may serve it, and the health
probe it is watched through. Written in Rust. Not publicly routable.

An upload lands in quarantine, under `uploads/` in the games bucket, which the CDN never reads. This
process claims the task the save queued, reads the quarantined bytes, holds them to the length and
the type the creator declared, and only then copies them to `assets/`, which the CDN serves. An
upload that fails stays where it is, and its creator is told why.

## The route

| Route         | Answers                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `GET /health` | `{"ok":true}`, or 503 until the consumer has joined its group and while it is down; no bearer |

Everything else is a refusal carrying `ErrorBody` from `libs/api-contract`: a `code` a caller matches
on and a `message` a human reads, on an unknown path as much as on an unanswered method. A `SIGTERM`
or `SIGINT` drains the listener for at most thirty seconds and only then stops the consumer, so an
asset claimed on the way out is settled rather than left for the reclaim window.

## The asset stream

A save that lands an asset writes a `Task` row in `@grove/api` and pushes its id onto
`grove:tasks:asset-upload`, and this process is what reads it. A consumer group rather than a list,
because a worker that dies mid-asset has to hand its claim back instead of taking the asset with it;
two workers sharing a name share their claims, which is why `UPLOAD_WORKER_NAME` falls back to the
hostname. A task id outside the request-id alphabet is acknowledged and dropped, because it becomes a
path segment and a header on the settle call.

One asset, start to finish:

1. The claim moves the task to `IN_PROGRESS`, and its answer carries the inspection: a presigned GET
   of the quarantined bytes, pinned to the version the save recorded, a presigned PUT to the key the
   CDN serves, the declared type and the declared length.
2. The bytes are read no further than one past the declared length. They must be exactly that long
   and begin the way their type does: PNG, JPEG, GIF and WebP by their signatures, MP3 by an ID3 tag
   or a frame sync, Ogg, WAV and WebM by theirs, WOFF2, WOFF, TrueType and OpenType by their tags,
   and JSON by parsing whole as UTF-8.
3. A pass is copied to `assets/` under its declared type, and the task settles `SUCCESSFUL` with the
   version the bucket gave the copy, which `@grove/api` checks before it marks the asset verified. A
   failure settles `FAILED` with a reason a creator can act on, at most 200 characters, and is never
   retried.

The bucket's credentials never reach this process: a claim's presigned URLs are all it holds of the
bucket, and they name one upload and one copy.

The connection redials on its own, `rediss://` included, and a consumer that fails outright is
started again five seconds later. A group the cache lost is created again, from the start of the
stream so that what was waiting is handed out again, and three passes over the stream failing in a
row turn `/health` to 503 until one answers.

A message is acknowledged once its outcome is written down. A claim that was refused is work somebody
already holds or settled: acknowledged, or it comes back forever. A status update the API rejects
outright, with a 400, 401 or 403, is acknowledged too, with an error line, since a retry would send
the same request. A bucket or an API that could not be reached leaves the message claimed for another
worker to take back after five minutes, and a message handed out more than five times is dropped
with an error line as one no worker can finish. The transitions are checked at `@grove/api`: a worker
that comes back from the dead cannot overwrite an outcome another already wrote.

## The credential

`ASSET_SERVICE_SECRET` is the bearer this process presents to the status route, and `@grove/api`
takes it for asset uploads and nothing else.

## What it does not own

What an asset means. The manifest that names it, the save that recorded its version, whether a game
holding it may be published: those are `@grove/api`'s. This service is handed a quarantined upload
and two presigned URLs, and its whole judgement is whether the bytes are what they were declared as.

| File          | Holds                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `main.rs`     | the composition root: config, the router, the listener, the consumer, the drain |
| `config.rs`   | the environment this process is deployed with                                   |
| `routes.rs`   | the health probe and the shape of a refusal                                     |
| `consumer.rs` | the asset stream, and what one claimed task does                                |
| `inspect.rs`  | the checks an upload must pass, and the bucket behind its presigned URLs        |
| `tasks.rs`    | the status route a task is claimed and settled through                          |

## Running it

```bash
cargo run --release
```

| Variable                    | What                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `ASSET_UPLOAD_SERVICE_BIND` | address to bind; `0.0.0.0:$PORT` where a platform sets `PORT`, else `127.0.0.1:4005` |
| `ASSET_SERVICE_SECRET`      | the bearer this process presents to `@grove/api`, at least 32 characters             |
| `API_URL`                   | where an asset upload is claimed and settled                                         |
| `REDIS_URL`                 | the asset stream every claim comes from                                              |
| `UPLOAD_WORKER_NAME`        | this process's name in the consumer group; the hostname when it is not set           |

`pnpm run build | test | typecheck` at the repo root reach this crate through `package.json`, whose
scripts shell to cargo: `typecheck` is `clippy -D warnings`. With no Rust toolchain on `PATH` they
print one `skipped:` line and succeed, so working on the TypeScript half does not require installing
Rust.

This crate, `@grove/game-instance` and the `request-id` crate they share are one cargo workspace
rooted at `apps/grove`, which is where the lock, the pinned toolchain and the release profile live;
`cargo` finds all three by walking up from here.
