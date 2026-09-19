# @grove/platform

Browsing and social: the front page, the whole sign-in flow, and the games a creator has made.

**This is the one Grove origin a password is typed on.** Signing up, signing in, the forgotten-password
path and changing a password all live here and nowhere else, which is what lets `@grove/editor` hold
no password field and no sign-in form of its own.

One of the two origins `@grove/api` accepts credentials from. A game is played on the player
origin, a separate registrable domain, because that is where creator code evaluates.

## The pages

Real paths rather than a fragment, because two of these addresses are written down outside this app
and cannot be changed by it: the editor sends somebody holding nothing to `/sign-in?return=`, and the
reset mail `@grove/api` sends links to `/reset-password?token=`.

| Path               | Holds                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| `/`                | What Grove is, and the two ways in, on one screenful                    |
| `/sign-in`         | An address and a password, and the way back the editor asked for        |
| `/sign-up`         | A display name, an address and a password                               |
| `/forgot-password` | Asking for a reset link                                                 |
| `/reset-password`  | Spending the key that link carried                                      |
| `/games`           | Every game this creator owns, newest first, and the way into the editor |
| `/profile`         | The name others see, the password, and closing the account              |

`src/router/routes.ts` is the whole of what an address means — parsing and writing are one module
with no DOM in it — and `src/router/useRoute.ts` is the subscription to the address bar. `popstate`
covers the back button and nothing else, because a browser does not fire it for a push this app
made, so `go` and `replace` tell the subscribers themselves.

`src/router/Link.tsx` sets a real `href` as well as handling the click, so a link can be
middle-clicked, copied and read by anything that looks at a page's links. A modifier or any button
but the first is left to the browser.

## The gates

`src/Site.tsx` decides which side of a gate a visitor is on, because whether a route needs a session
is a fact about the route and a page that had to check for itself is a page that can forget to.
Both redirects **replace** rather than push: somebody bounced off a page they could not see should
not have to click back twice to get past it.

- **No session, on `/games` or `/profile`** → `/sign-in`.
- **A session, on `/sign-in` or `/sign-up`** → `/games`, unless the editor sent them, which is the
  next section.

The reset pages are behind neither gate: somebody signed in on this tab may still be setting a new
password.

## Crossing to the editor

`VITE_EDITOR_URL` is where the editor is, and `src/editor/link.ts` is the only module that builds a
link to it. Nothing of the session travels on that URL: the API set the cookie on its own origin and
the editor reads the same one, so this is a destination rather than a credential, and there is
nothing on it to leak into a history entry or a `Referer`.

A `return=` the editor sent is honoured **only when it is on the editor's own origin**. Anything
else is dropped for the editor's front door instead — a link written by anybody could otherwise
bounce a creator off this origin onto a page dressed as it. Nothing is not a failure here; it is the
front door.

Somebody the editor sent to `/sign-in` who already holds a session is sent straight back rather than
parked on a games page they did not ask for: the editor will read the cookie they are already
carrying, so there is nothing here for them to sign in to. That crossing happens once per tab, not
once per render.

**The editor opens a creator's newest game and nothing selects another**, so `/games` offers to open
only the first card and says which game that is. A button on the rest would name one game and open a
different one. `New game` makes one and then crosses, in that order, because making it is what makes
it the newest.

## The session

`src/session/SessionProvider.tsx` holds who is signed in, read once on the first load and kept for
every page after it. Two calls rather than one: `GET /v1/auth/session` is the route that answers a
cookie naming nobody without it being a failure, and it hands back the CSRF token every write here
has to carry — so it runs before the account is read and before any form can be submitted. An API
nobody can reach is a visitor who is not signed in, which leaves the pages in front of the gate
working.

`src/api/client.ts` is every call to `@grove/api` and the only place that CSRF token lives, because a
component that had to carry it from the sign-in to the next write is one that can drop it. The API is
a different origin, so every call is `credentials: 'include'`.

A refusal a person can act on comes back as an **answer** rather than as something thrown past the
form: a cookie naming nobody, a credential that opens no account, a spent reset key and a wrong
current password are each a value the caller branches on. `src/api/messages.ts` turns anything else
into one sentence, keeping the service's own wording where it wrote some — it is the end that knows
which field was wrong.

## What a page is allowed to say

Three refusals are deliberately vague, and each is vague in the same way the service is:

- **A credential that opens nothing** is one message for an unknown address, a wrong password and a
  locked account. Which of the three it was is the fact an enumeration is looking for.
- **Asking for a reset link** says the same thing whether or not that address has an account.
- **A reset key** that is wrong, already spent or expired is one answer.

The reset key is taken out of the address bar as soon as it has been read, for the reason any
credential in a URL is: a URL reaches the history, a bookmark and the `Referer` of every request the
page goes on to make. `hrefOf` cannot write one back.

## The look

**Pixel Grove**, dark only, and `@grove/ui` owns all of it — the palette, the components, and how
a surface is built: the 3px edge, the solid block it drops, and the stepped corner it is clipped to.
This app adds `src/styles/platform.css` and nothing else. Every page is a column of at most
`--shell-measure`, every gap and padding is a `--pg-sp-*` step, and no rule here names a colour that
is not a `--pg-*` token or draws an edge that is not `--pg-bw` — the kit says how a surface looks,
and this sheet only says where the surfaces go.

The nav and the footer are `Panel`s like every other surface rather than divs with a rule under
them, which is why the header is not sticky: a panel drops a solid block, and a sticky one would
drag that block down the page behind it. Two places invert to the plate pair rather than to the
page's own ink — a hovered nav link and a hovered link in the sign-in flow — because `--pg-ink` is
the light parchment in dark, and a plate painted with it would be sun text on cream.

`index.html` loads Press Start 2P and VT323, carries `class="pg-scanlines"` for the wash the kit
paints over the viewport, and hard-codes `data-theme="dark"` on `<html>`. There is no toggle and no
`ThemeProvider` here: light is the editor's theme, because that is the app somebody reads code in
all day, and this one is a front door. The kit still ships both, so nothing about `@grove/ui`
changes.

## The environment

| Variable          | What                                                         |
| ----------------- | ------------------------------------------------------------ |
| `VITE_API_URL`    | Where `@grove/api` is; `http://localhost:4000` by default    |
| `VITE_EDITOR_URL` | Where `@grove/editor` is; `http://localhost:5176` by default |

## Running it

Consumers resolve `@grove/ui` from its built `dist` (`pnpm --filter @grove/ui build`), so
`pnpm --filter @grove/platform dev` builds it first and then serves on port 5175 — the port
`@grove/editor` dials when it sends somebody here.

The pages above are paths, so whatever serves the built `dist/` has to answer an unknown path with
`index.html`. Vite's own dev and preview servers already do.
