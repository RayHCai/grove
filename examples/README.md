# @platform/examples

Phase-0 sample games, used as regression tests.

Each game is written against `api_spec.ts` and is illustrative only — the engine is
still a shell package, so nothing here is compiled or run. They exist to be _read_:
a design decision that produces awkward creator code shows up here first.

| Game                                           | Shape                        | What it exercises                                                                      |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| [seed-sprint/](games/seed-sprint/game.ts)      | single-player platformer     | `PlatformerMovement` and one subclass, chunk streaming (§8.4), parallax, no HUD at all |
| [battle-royale/](games/battle-royale/index.ts) | multiplayer top-down shooter | `TopDownMovement`, the roster and phases, requests, per-player state, a leaderboard    |

**One file per host**, named after what it is attached to, holding every script the
panel attaches there — a script is only ever attached to one host, which makes this
the grouping with no ambiguous cases. Files carry no location suffix, because a
host's scripts do not share one; each file's header lists what it holds, and every
class declares its own execution site in `extends`.

Attachment is panel mapping (§3.2), so nothing imports these to run them and a barrel
buys nothing — the panel is the manifest. Start at the file linked above, whose header
carries the game's file map and the list of what the panel authors.
