---
name: run-grove
description: Start Grove locally and see a change working in the real app — the stores, the services, a browser app, or one fleet box end to end. Use when asked to run, start, open or screenshot Grove, or to confirm a change works outside the test suites.
---

# Running Grove

`readme.md`'s "Running it locally" section is the source for every command and port below; if the two
disagree, it wins and this file is stale.

## 1. Pick the smallest layer the change needs

| Change touches                            | Start                                               |
| ----------------------------------------- | --------------------------------------------------- |
| A browser app's UI only                   | that app's dev server (step 3); no compose needed   |
| `@grove/api` or anything a page calls     | `docker compose --profile app up -d`, then step 3   |
| A session end to end (join, play, socket) | `docker compose --profile fleet up -d`, then step 3 |
| Only Postgres/Redis/S3 for a test         | `docker compose up -d`                              |

Compose needs a root `.env`: copy `.env.example` if it is missing, and never overwrite one that exists.
Compose runs the services from their deploy images, so a service source edit needs
`docker compose --profile app up -d --build <service>` to be live.

## 2. Check before starting

The user often has servers running already. Probe first and reuse what answers:

```sh
curl -sf http://localhost:4000/health >/dev/null && echo api up
curl -sf http://localhost:5175/ >/dev/null && echo platform up
```

A dev server that dies with `EADDRINUSE` means one is already running on that port: use it.

## 3. Browser apps

Run in the background, then poll the port until it answers:

```sh
pnpm --filter @grove/platform dev    # localhost:5175
pnpm --filter @grove/editor dev      # localhost:5176
pnpm --filter @grove/player-app dev  # localhost:5177
```

Each `dev` builds `@grove/ui` first. The editor's `try.html` plays the default template with no API.

## 4. Look at it

Drive the page with `playwright-core` installed in the scratchpad (not the repo), launching an
installed browser through `channel: 'msedge'` or `'chrome'` so nothing is downloaded. Screenshot with
`page.screenshot()`, log `console` errors, and compare `scrollWidth` to `clientWidth` for horizontal
overflow. Measure a game canvas only with a screenshot: pixi draws through WebGL without
`preserveDrawingBuffer`, so `getImageData` reads black whatever is on screen.

## 5. Stop what you started

Stop only the processes and containers this session started (`docker compose stop`, or kill the dev
server's listener by port), never ones that were already running.
