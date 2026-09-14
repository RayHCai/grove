# @grove/api

The public HTTP surface for accounts, projects, social and joining a game: every route, the gates in
front of it, and the ticket the allocator signs.

The only service a browser talks to over HTTP. It never sits on a per-tick path — a client dials its
game process directly, with a ticket this service signed. Sessions live in the process that minted
them, so it runs as one replica: a second would not recognise the first's cookie. Every write but
the sign-in that mints it carries the CSRF token in `x-csrf-token`, and `GET /v1/auth/session` hands
another to a browser still holding the cookie; a read carries nothing but the cookie.

## The seams

Three dependencies arrive as arguments to `buildApp` rather than as handles a route reaches for, so
what stands behind each one is chosen where the process starts. `Records` answers which account a
credential names and who owns a game; `Fleet` answers where a joining player should dial; `Builder`
stores an upload and asks for a build of it.

`main.ts` hands the fleet and the builder the services named in the environment, and hands `Records`
the seam with nothing behind it. That last one decides what a deployed process answers: sign-in is
`401` for every credential, and so is every route behind the cookie, because the session those
routes read is the one a sign-in mints.

Behind that gate, a join asks the router for a placement — `409` when the fleet has no box to spare,
`500` when the router itself fails — and a publish stores the source under its SHA-256 and answers
`202` carrying the builder's own job id, the `429` the builder rationed it with, or `502` when the
builder refused it; against the unattached builder it answers `501` rather than an id nothing will
report on. An ownership check against the unattached records seam is a `403`,
`GET /v1/games/:gameId/versions/latest` is a `404` for every game, and `GET /v1/social/friends` the
empty list.

## The environment

Nothing that decides a secret or a cookie flag has a default: this is the one service on the public
internet, and a value that fell back to something would be a choice nobody made. `API_HOST` and
`API_PORT` are the two conveniences that carry one.

| Variable             | What                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | `development`, `test` or `production`; sets the log level and the cookie's `secure` flag                                                                                                                          |
| `API_HOST`           | address to bind, `0.0.0.0` by default                                                                                                                                                                             |
| `API_PORT`           | `4000` by default                                                                                                                                                                                                 |
| `SESSION_SECRET`     | signs the browser session cookie, at least 32 characters                                                                                                                                                          |
| `GAME_TOKEN_SECRET`  | signs the game-scoped tokens the allocator mints — a different key, a different blast radius                                                                                                                      |
| `FLEET_SECRET`       | the bearer this service presents to the fleet's own services, at least 32 characters — a third key, a third blast radius                                                                                          |
| `SERVER_MANAGER_URL` | where a placement is asked for, once per join                                                                                                                                                                     |
| `UPLOAD_SERVICE_URL` | where a publish puts the source, under the hash a build names it by                                                                                                                                               |
| `GAME_BUILDER_URL`   | where a build is queued                                                                                                                                                                                           |
| `TRUSTED_PROXIES`    | comma-separated peers whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed: addresses, CIDR blocks, `loopback` or `uniquelocal` — one that does not name the real peer leaves the production cookie unset |
| `PLATFORM_ORIGIN`    | an origin allowed to send credentials                                                                                                                                                                             |
| `EDITOR_ORIGIN`      | the other one                                                                                                                                                                                                     |

The player origin is deliberately absent from that pair: it runs creator code and never calls this
service, so letting it send credentials would be handing them away.
