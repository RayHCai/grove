# Last Sprout

A small top-down multiplayer battle royale. Ready up in the greenhouse, drop into
the arena, switch weapons from the hotbar, be the last sprout standing before the
clock runs out.

Illustrative only — written against `api_spec.ts`, not compiled or run.

One file per template, named after it, holding every script the panel attaches to
it plus that template's own constants. The Game counts as a template (§3.4).

| File           | Contents                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `game.ts`      | `Match` — phases, clock, ring, roster, leaderboard. `Screens` — which screen is up, music. Round length, ring count, players needed. |
| `player.ts`    | `Vitals` — health, kills, ready. `Loadout` — weapon and ammo, `@onRequest('equip')`. `Feel` — camera, cursor. Max health.            |
| `fighter.ts`   | The avatar. `Sprout` — tag, walk speed. `Gunplay` — firing, resupply. `Hitbox` — takes damage. `Wilt` — death animation.             |
| `shot.ts`      | `Shot` — one pellet: travel, hit, self-destruct.                                                                                     |
| `lobby.ts`     | `Greenhouse` — ready button, player count, leaderboard.                                                                              |
| `arena-hud.ts` | `Arena` — health, clock, ring, kills, 3-slot hotbar.                                                                                 |
| `weapons.ts`   | The three weapons: damage, spread, range, cooldown, ammo, sound.                                                                     |
| `state.ts`     | Typed accessors for replicated state — the §6.1 hoisting cast, in one place.                                                         |

Also panel-authored: the `greenhouse` / `arena` / `ring-1..3` regions, the `crate`
template (no scripts — read by tag), the `wilt` clip, the `shoot` / `equip-1..3`
actions.
