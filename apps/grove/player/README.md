# @grove/player-app

The origin a game renders on: the join it is handed, the loading screen over it, and the session
underneath.

A separate registrable domain from the platform, because creator `ClientScript` code may only
evaluate on an origin that carries no visitor's platform session.

## Arriving

This origin talks to `@grove/api` never. It is absent from that service's CORS allowlist on purpose
(it runs creator code, and letting it send credentials would be handing them away), so nothing
here can ask for a join. The platform asks, behind the cookie, and leaves the answer in this page's
**url fragment**.

A fragment rather than a query: a fragment is never sent to a server, so the ticket stays out of
access logs, proxy traces and `Referer` on the way over. It carries a `PlayHandoff` as base64url of
its JSON (`encodeHandoff` and `decodeHandoff` in `@grove/api-contract`, so the platform that writes
it and this page that reads it share one codec), because the browser percent-decodes a fragment and a raw one would depend on which
characters a given browser chose to escape. It is parsed against the contract rather than cast:
everything in it reaches a socket and a renderer, and it is the one input on this page anybody can
type. Four answers (a join, nothing at all, a link this page cannot read, or a join naming a server
outside the fleet), each worded on its own, since the second is somebody who opened the origin
directly, the third a link that was truncated and the fourth a link somebody wrote.

The server a join names chooses the code this origin goes on to run, so it is dialled only over
`wss:` (`ws:` too in a dev server) and only at or under one of `VITE_GAME_HOSTS`, matched at a label
boundary; anything else is refused before a socket opens (`src/servers.ts`).

The fragment is taken back out of the address bar once read. A ticket lives sixty seconds and is
spent at the upgrade, so what that avoids is a reload: the fragment would survive one, and a second
dial with a spent ticket reads as the game being broken rather than as a link already used.

## Joining

`@grove/player`'s `GamePlayer` is the surface, and it is mounted **under** the loading screen rather
than after it: the session builds a renderer and dials while the screen is up, and swapping the
tree when it went live would tear that renderer down and start the join again.

The ticket rides the WebSocket **subprotocol**, as `grove.ticket.<token>`: a browser cannot set a
header on `new WebSocket(url)`, and a url ends up in the same logs a fragment exists to stay out of.

The creator's code is **not** fetched here, and this origin never learns a bundle url from the
allocator. The authority names one in the `Welcome`, and the session fetches, bounds, hashes and
verifies it before evaluating a byte, so what decides which code runs is the world a player
actually landed in, rather than this service's guess at which one that would be. What the handoff
does carry is `projectId` and `projectHash`, because the handshake compares those before a `Player`
is allocated and only the bundle hash has an empty-string escape: a page that arrived without them
could not be admitted to anything.

A refusal is a line a person can act on, never a token and never what the session said, which can
name a box. `version` means the world moved on while this tab sat on the link and starting again is
the fix; `full` is a thing to wait out; `ticket` is a socket that never opened, which a browser
cannot tell apart from a box it could not reach, so it is a link to get a new one for. Every refusal
offers the way back to the platform.

## The look

`@grove/ui` supplies the palette, the type and the one button this origin draws; the loading
screen and a refused join are the only chrome here, and everything else on screen is the game's.
Dark only, like the platform: there is no toggle and no `ThemeProvider`, so `index.html`
hard-codes `data-theme="dark"`.

## The environment

| Variable            | What                                                           |
| ------------------- | -------------------------------------------------------------- |
| `VITE_PLATFORM_URL` | where a refused join sends somebody back to                    |
| `VITE_GAME_HOSTS`   | the hosts a join's server may sit at or under, comma-separated |

A dev server falls back to `http://localhost:5175` and dials any host; a production build without
either throws at load rather than sending somebody to their own machine or dialling whatever a link
names. `.env.example` lists both, and `src/vite-env.d.ts` types them.

A production build carries its Content-Security-Policy as a `<meta>` tag, since a static host is
told nothing but the files: scripts from this origin and a verified bundle's blob and nothing evaluated
from a string (the renderer loads pixi's no-eval shader syncs), sockets to `VITE_GAME_HOSTS` over `wss:`
alone, and `https:` for bundles and art from an edge the build is not told. A dev server carries
none, because its React refresh preamble is an inline script.

`pnpm run dev | build | test | typecheck` at the repo root reach this app through `package.json`.
