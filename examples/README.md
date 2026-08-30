# @platform/examples

Sample games, type-checked against the creator surface.

Each game is written the way a creator writes one, against `@platform/engine`. They compile as part
of the build, so a change that makes creator code awkward or impossible shows up here first. Nothing
runs them: attachment is panel mapping, so there is no entry point to import.

| Game                                            | Shape                        | What it exercises                                                                   |
| ----------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| [seed-sprint/](games/seed-sprint/game.ts)       | single-player platformer     | `PlatformerMovement` and one subclass, chunk streaming, parallax, no HUD at all     |
| [battle-royale/](games/battle-royale/README.md) | multiplayer top-down shooter | `TopDownMovement`, the roster and phases, requests, per-player state, a leaderboard |

**One file per host**, named after what it is attached to, holding every script the
panel attaches there — a script is only ever attached to one host, which makes this
the grouping with no ambiguous cases. Files carry no location suffix, because a
host's scripts do not share one; each file's header lists what it holds, and every
class declares its own execution site in `extends`.
