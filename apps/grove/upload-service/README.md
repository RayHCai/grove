# @grove/upload-service

Content-addressed object storage: the bundles a session loads, the assets a game draws with, and the
source archives `@grove/game-builder` compiles. Written in Rust. Not publicly routable.

An object is named by the SHA-256 of its own bytes, so the name is the integrity check rather than a
label beside one. A `PUT` whose body hashes to something else is refused and nothing is stored.

## Why this one is Rust

An object is multi-megabyte and arrives and leaves as a stream, so the hot loop is a hash over bytes
that never need to be resident. The memory cost of a concurrent upload is a buffer and a hasher
rather than a body, which is what lets one box hold a publish burst without sizing a heap for it.

## The routes

| Route                       | Answers                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| `GET /health`               | `{"ok":true}`, outside the bearer layer                               |
| `PUT /v1/objects/{hash}`    | 201 for a first store, 200 for bytes already held, 400 for a mismatch |
| `HEAD /v1/objects/{hash}`   | 200 with `Content-Length` and `Content-Type`, or 404                  |
| `GET /v1/objects/{hash}`    | the bytes, streamed, under an immutable cache header, or 404          |
| `DELETE /v1/objects/{hash}` | 204, or 404 when nothing was there to remove                          |

A read is `public, max-age=31536000, immutable`, which a content address earns: the name can never
come to mean different bytes, so a cache that keeps it forever is never wrong.

A `Content-Length` above the ceiling is 413 before a byte is read, a body that runs past it
mid-stream is abandoned, and one that stops arriving for thirty seconds is dropped. A `PUT` that
skipped the write because the object was already held answers 409 if that copy is gone or is no
longer whole by the end of the body. Sixty-four object requests run at once and the rest wait,
because an upload in flight is a descriptor and a file in `incoming/`. A `SIGTERM` drains for thirty
seconds and then drops whatever is still open, because a peer that has stopped reading is never
polled again. Refusals carry `ErrorBody` from `libs/api-contract` — a `code`
a caller matches on and a `message` a human reads, on an unknown path or an unanswered method as much
as on a bad body.

## The store

`objects/<ab>/<hash>` holds the bytes and a `.type` sidecar beside it holds the content type; one
directory per two-hex prefix keeps a shard to a listing a tool will open. An upload lands in
`incoming/` under a name of its own and is renamed into place only once its hash is its name — a
partial object must never be readable under its final name, and a rename is the only atomic step a
filesystem gives you. `incoming/` is a sibling of `objects/` because that atomicity holds only within
one filesystem. Opening a root sweeps the temp files in it that have sat untouched for an hour, which
is the only thing that ever removes a `.part` an earlier process abandoned.

Everything above sits behind `ObjectStore`, a four-method trait the handlers hold as an
`Arc<dyn ObjectStore>`. The trait speaks in byte streams rather than buffers, which is what keeps the
per-upload cost a chunk.

## The bearer

Every `/v1` route is behind one shared fleet secret, compared in constant time. One secret rather
than a credential per caller: nothing outside the fleet can route here, and the callers are
`@grove/game-builder`, `@grove/game-instance` and `@grove/api` rather than a population.

## What it does not own

What an object means. A bundle set, a manifest, which build produced which hash — those are
`@grove/game-manager`'s and `@grove/game-builder`'s. This service is told a name and given bytes, and
its whole judgement is whether the two agree.

| File        | Holds                                                             |
| ----------- | ----------------------------------------------------------------- |
| `main.rs`   | the composition root: config, the router, the listener, the drain |
| `config.rs` | the environment this process is deployed with                     |
| `auth.rs`   | the fleet bearer layer                                            |
| `routes.rs` | the handlers and the shape of a refusal                           |
| `store.rs`  | the object store and the seam a backing store answers             |

## Running it

```bash
cargo run --release
```

| Variable              | What                                          |
| --------------------- | --------------------------------------------- |
| `UPLOAD_SERVICE_BIND` | address to bind, `127.0.0.1:4005` by default  |
| `UPLOAD_ROOT`         | the directory objects live under              |
| `FLEET_SECRET`        | the shared bearer every `/v1` caller presents |
| `UPLOAD_MAX_BYTES`    | bytes one object may reach, 64 MiB by default |

`pnpm run build | test | typecheck` at the repo root reach this crate through `package.json`, whose
scripts shell to cargo — `typecheck` is `clippy -D warnings`. With no Rust toolchain on `PATH` they
print one `skipped:` line and succeed, so working on the TypeScript half does not require installing
Rust.

This crate and `@grove/game-instance` are one cargo workspace rooted at `apps/grove`, which is where
the lock, the pinned toolchain and the release profile live — `cargo` finds all three by walking up
from here.
