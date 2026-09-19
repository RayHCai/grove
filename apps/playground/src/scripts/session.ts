// `declareVisuals` belongs to the server that booted the world and nothing a script can name
// reaches it, so the host grants that one call by name. Everything else is `host.getScript()`.

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
