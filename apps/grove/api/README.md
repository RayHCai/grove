# @grove/api

The public API: accounts, projects, social, and the allocator that mints join tickets.

The only service a browser talks to over HTTP. It never sits on a per-tick path — a client dials its
game process directly, with a ticket this service signed.

## The environment

Every value is required and none has a default: this is the one service on the public internet, and
a secret that fell back to something would be a secret nobody chose.

| Variable            | What                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | `development`, `test` or `production`; sets the log level and the cookie's `secure` flag     |
| `API_HOST`          | address to bind, `0.0.0.0` by default                                                        |
| `API_PORT`          | `4000` by default                                                                            |
| `SESSION_SECRET`    | signs the browser session cookie, at least 32 characters                                     |
| `GAME_TOKEN_SECRET` | signs the game-scoped tokens the allocator mints — a different key, a different blast radius |
| `PLATFORM_ORIGIN`   | an origin allowed to send credentials                                                        |
| `EDITOR_ORIGIN`     | the other one                                                                                |

The player origin is deliberately absent from that pair: it runs creator code and never calls this
service, so letting it send credentials would be handing them away.
