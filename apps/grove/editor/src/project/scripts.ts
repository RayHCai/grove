// What the manifest restates about the code: which classes a project exports, where each runs and
// what it may be attached to. A creator declares none of it — the base class in the source is the
// declaration, and this reads it back.

import { scriptId } from '@platform/project';
import type { ScriptDecl, ScriptHost, ScriptLocation, ScriptModule } from '@platform/project';

/** A top-level exported class and the class it extends; type arguments are the host. */
const DECLARATION =
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)\s*(?:<\s*([A-Za-z_$][\w$]*)\s*>)?/gmu;

/** Where each engine base runs. `BaseScript` is absent: a location is what its three heirs add. */
const LOCATIONS: ReadonlyMap<string, ScriptLocation> = new Map([
    ['ServerScript', 'server'],
    ['ClientScript', 'client'],
    ['SyncedScript', 'synced'],
    ['BaseMovement', 'synced'],
    ['TopDownMovement', 'synced'],
    ['PlatformerMovement', 'synced'],
]);

/**
 * The bases that name their own host.
 *
 * A movement moves one body, so it is entity-hosted whatever it is written as — which is why a
 * creator writes `extends TopDownMovement` with no type argument and owes nothing further.
 */
const IMPLIED_HOST: ReadonlyMap<string, ScriptHost> = new Map<string, ScriptHost>([
    ['BaseMovement', 'entity'],
    ['TopDownMovement', 'entity'],
    ['PlatformerMovement', 'entity'],
]);

/** The type argument a script base takes, as the manifest names the same thing. */
const HOSTS: ReadonlyMap<string, ScriptHost> = new Map<string, ScriptHost>([
    ['Entity', 'entity'],
    ['Player', 'player'],
    ['Game', 'game'],
    ['Camera', 'camera'],
    ['HUDScreen', 'screen'],
]);

/** Why one class could not be declared, in a line the console pane prints beside its file. */
export interface ScriptFault {
    path: string;
    name: string;
    message: string;
}

export interface ScanResult {
    modules: ScriptModule[];
    faults: ScriptFault[];
}

/** One source, as the scan reads it. */
export interface ScannedSource {
    path: string;
    text: string;
}

interface Found {
    path: string;
    name: string;
    base: string;
    host: string | undefined;
}

/** `src/player.ts#Walk` without the extension — the id the toolchain stamps a chunk with. */
function idOf(path: string, name: string): string {
    return `${path.replace(/\.tsx?$/u, '')}#${name}`;
}

/**
 * Every script class the project exports, by the module holding it.
 *
 * A class extending another of the project's own carries that one's location and host, so a
 * movement somebody subclassed twice is still an entity-hosted synced script. A class that reaches
 * no engine base is not a script at all — plain code a script imports — and is passed over in
 * silence; one that reaches a base but names no host is a fault, because the manifest is what
 * refuses an illegal attachment and it cannot do that without knowing what this attaches to.
 */
export function scanScripts(sources: readonly ScannedSource[]): ScanResult {
    const found: Found[] = [];
    for (const source of sources) {
        if (!/\.tsx?$/u.test(source.path)) continue;
        for (const match of source.text.matchAll(DECLARATION)) {
            found.push({
                path: source.path,
                name: match[1] ?? '',
                base: match[2] ?? '',
                host: match[3],
            });
        }
    }

    const byName = new Map(found.map((each) => [each.name, each]));
    const byPath = new Map<string, ScriptDecl[]>();
    const faults: ScriptFault[] = [];

    for (const each of found) {
        const placed = place(each, byName);
        if (placed === undefined) continue;
        if (typeof placed === 'string') {
            faults.push({ path: each.path, name: each.name, message: placed });
            continue;
        }
        const declared = byPath.get(each.path) ?? [];
        declared.push({
            id: scriptId(idOf(each.path, each.name)),
            export: each.name,
            location: placed.location,
            host: placed.host,
        });
        byPath.set(each.path, declared);
    }

    const modules = [...byPath.entries()]
        .map(([path, scripts]) => ({ path, scripts }))
        .toSorted((left, right) => left.path.localeCompare(right.path));
    return { modules, faults };
}

/**
 * Where one class runs, following the chain of its own project's classes to an engine base.
 * `undefined` is not a script; a string is one that is, and cannot be declared.
 */
function place(
    start: Found,
    byName: ReadonlyMap<string, Found>,
): { location: ScriptLocation; host: ScriptHost } | string | undefined {
    const seen = new Set<string>();
    let at: Found | undefined = start;
    let host = start.host;

    while (at !== undefined) {
        // A class extending itself through a chain is a program that will not compile; the
        // checker says so, and this must not spin while it does.
        if (seen.has(at.name)) return undefined;
        seen.add(at.name);

        const location = LOCATIONS.get(at.base);
        if (location !== undefined) {
            const implied = IMPLIED_HOST.get(at.base);
            if (implied !== undefined) return { location, host: implied };

            if (host === undefined) {
                return `${at.base} needs the host it attaches to, as ${at.base}<Entity>`;
            }
            const named = HOSTS.get(host);
            if (named === undefined) return `${host} is not something a script attaches to`;
            return { location, host: named };
        }

        const next: Found | undefined = byName.get(at.base);
        host = host ?? next?.host;
        at = next;
    }
    return undefined;
}
