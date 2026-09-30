# @grove/service-kit

What every Node service in the fleet starts the same way, so `@grove/api` and `@grove/game-builder`
cannot drift apart on it:

| Export                                      | Holds                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `parseEnv(schema, source)`                  | the zod parse that refuses a bad environment naming every variable at once               |
| `withPlatformPort(source, names)`           | a platform-assigned `PORT` as the fallback for a service's own port, binding `0.0.0.0`   |
| `serviceOptions(nodeEnv)`                   | the Fastify logger level and the correlation-id generator                                |
| `installServiceHandlers(app)`               | the zod codecs, the shared `ErrorBody` failure shape, and `x-request-id` on every answer |
| `installErrorHandler(app)`                  | the failure shape on its own                                                             |
| `fleetCall({ baseUrl, secret, timeoutMs })` | a `fetch` to a fleet peer carrying the bearer, the correlation id and a deadline         |

Node only: it takes Fastify and `node:crypto`, which is why these live here and not in
`@grove/api-contract`, which a browser imports.

`grove-dev [entry]` is the dev loop both services' `dev` script runs: `tsc --watch` rebuilding
`dist/` and `node --watch` restarting on each rebuild, as two child processes and no shell syntax,
so it behaves the same on Windows.
