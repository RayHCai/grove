// The one capability the game asks its host for.
//
// `declareVisuals` belongs to the server that booted the world and nothing a script can name reaches
// it, so the host grants the one call by name. Everything else a script needs from another script is
// `host.getScript(Class)`, which is per-WORLD rather than per-process.

let declareCrownArt: (() => void) | null = null;

/** Granted by the composition root once the world exists; `null` drops it. */
export function onCrownNeeded(declare: (() => void) | null): void {
    declareCrownArt = declare;
}

/** Announces the crown's art. Answers `false` when no host supplied the call. */
export function declareCrown(): boolean {
    if (declareCrownArt === null) return false;
    declareCrownArt();
    return true;
}

/** Drops the grant, so a second world in one process does not inherit the first's. */
export function resetSession(): void {
    declareCrownArt = null;
}
