// The one live match, so a script on any host can reach the rules that own it.
//
// The runtime exposes no "get me that host's script" API: `Entity` and `Player` hold no route back
// to the Game, `Game` holds no route to a script instance, and core's `game` const reads a
// module-global a co-located client would repoint. A script that needs the match therefore has to
// be told about it, and this is where `Rules` says so.
//
// The `Rules` import is TYPE-ONLY and must stay that way. `rules.ts` imports this module to publish
// itself; a value import back would close a runtime cycle.

import type { Rules } from './game/rules.js';

let live: Rules | null = null;

/** Set by `Rules` at `@onStart` and cleared at `@onEnd`. */
export function publishRules(rules: Rules | null): void {
    live = rules;
}

/** The running match, or `null` between worlds. Every caller outside `Rules` goes through here. */
export function currentRules(): Rules | null {
    return live;
}

/**
 * What the host supplies that no script can reach.
 *
 * `declareVisuals` belongs to the `GameServer`, and a script has no route to the process that built
 * it — so the composition root injects the one call the game needs and the game asks for it by
 * name. It is the same shape a real platform's capability grant would take.
 */
let declareCrownArt: (() => void) | null = null;

export function onCrownNeeded(declare: (() => void) | null): void {
    declareCrownArt = declare;
}

/** Announces the crown's art, once. Answers `false` when no host supplied the call. */
export function declareCrown(): boolean {
    if (declareCrownArt === null) return false;
    declareCrownArt();
    return true;
}

/** Drops every slot, so a second world in one process does not inherit the first's. */
export function resetSession(): void {
    live = null;
    declareCrownArt = null;
}
