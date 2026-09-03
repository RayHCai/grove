// One authored game, reduced to the few things that differ between suites.
//
// Every component suite needs its own world — a camera test and a movement test want different
// templates, different scripts and different bounds — but they all need the same eleven fields of
// boilerplate around them. `defineWorld` takes the differences and derives the rest.
//
// The derivation is the point, not the brevity: `scriptModules` and the two registries all restate
// the same script list, and a world that declared a script in one and forgot it in another would
// fail at load with a message about the manifest rather than about the mistake.

import { PROJECT_FORMAT_VERSION, assetId, scriptId, templateId } from '@platform/project';
import type {
    AssetRecord,
    EntityRecord,
    ProjectBounds,
    ProjectManifest,
    RegionRecord,
    ScriptAttachment,
    ScriptHost,
    ScriptId,
    ScriptLocation,
    ScriptModule,
    ScriptProps,
    TemplateRecord,
} from '@platform/project';
import { ScriptRegistry } from '@platform/scripting';
import type { ScriptClass } from '@platform/scripting';

/** Structurally assignable to `@platform/client`'s `Binding`, which keeps this file free of it. */
export type StageBinding = { kind: 'button'; code: string; action: string };

/**
 * One script, declared once.
 *
 * `location` and `host` are what the manifest validator checks an attachment against; `ctor` is what
 * a registry hands the loader. Declaring them together is what stops the two from disagreeing.
 */
export interface WorldScript {
    readonly id: string;
    readonly export: string;
    readonly path: string;
    readonly location: ScriptLocation;
    readonly host: ScriptHost;
    readonly ctor: ScriptClass;
}

/** A HUD screen the harness opens once per tab, and the client script it attaches to it. */
export interface ScreenSpec {
    readonly name: string;
    readonly script: ScriptClass;
}

export interface WorldSpec {
    /** Becomes both the project id and the content hash, so two worlds never pass each other's handshake. */
    readonly id: string;
    readonly scripts?: readonly WorldScript[];
    readonly templates?: readonly TemplateRecord[];
    readonly entities?: readonly EntityRecord[];
    readonly gameScripts?: readonly ScriptAttachment[];
    readonly assets?: readonly AssetRecord[];
    readonly bounds?: ProjectBounds;
    readonly regions?: readonly RegionRecord[];
    readonly simRate?: number;
    readonly sendRate?: number;
    readonly maxPlayers?: number;
    readonly bindings?: readonly StageBinding[];
    readonly screens?: readonly ScreenSpec[];
    /** A numeric widget the harness draws on the renderer's `ui` surface. */
    readonly mirrorWidget?: string;
}

/** Everything a `Session` needs to stand up both ends of one game. */
export interface World {
    readonly project: ProjectManifest;
    readonly server: ScriptRegistry<ScriptId>;
    readonly client: ScriptRegistry<ScriptId>;
    readonly bindings: readonly StageBinding[];
    readonly screens: readonly ScreenSpec[];
    readonly simRate: number;
    /** Set, the harness mirrors this widget onto the renderer — proving `hud` reaches drawn art. */
    readonly mirrorWidget?: string;
}

export const SIM_RATE = 60;
export const SEND_RATE = 20;

/** The extent every world gets unless it asks for another. Wide enough for four lanes of avatars. */
export const WORLD_BOUNDS: ProjectBounds = { left: -320, right: 320, top: 180, bottom: -180 };

/** The key core's roster spawns an avatar from. Named by core, not by any project. */
export const TEMPLATE_AVATAR = 'player';

export const ASSET_DISC = 'disc';

/**
 * The one asset every world gets.
 *
 * A sprite template needs a declared texture, and a click needs something DRAWN to land on — so a
 * world with no art of its own still cannot use a group visual for anything it intends to hit.
 */
export const DISC_ASSET: AssetRecord = {
    id: assetId(ASSET_DISC),
    kind: 'texture',
    url: '/disc.png',
    meta: { width: 24, height: 24 },
};

/** A sprite template with no children, which is what most of these suites want. */
export function sprite(
    id: string,
    scripts: ScriptAttachment[] = [],
    tint?: number,
): TemplateRecord {
    return {
        id: templateId(id),
        visual:
            tint === undefined
                ? { kind: 'sprite', texture: assetId(ASSET_DISC) }
                : { kind: 'sprite', texture: assetId(ASSET_DISC), tint },
        scripts,
    };
}

/** An attachment by script id, so a world names a script the same way the manifest does. */
export function attach(id: string, props?: ScriptProps): ScriptAttachment {
    return props === undefined ? { script: scriptId(id) } : { script: scriptId(id), props };
}

function entryOf(s: WorldScript) {
    return { id: scriptId(s.id), location: s.location, ctor: s.ctor };
}

export function defineWorld(spec: WorldSpec): World {
    const scripts = spec.scripts ?? [];

    // Grouped by source module, because that is the unit a loader reaches a class through — two
    // classes exported from one file are one entry, not two.
    const byPath = new Map<string, ScriptModule>();
    for (const s of scripts) {
        let module = byPath.get(s.path);
        if (module === undefined) {
            module = { path: s.path, scripts: [] };
            byPath.set(s.path, module);
        }
        module.scripts.push({
            id: scriptId(s.id),
            export: s.export,
            location: s.location,
            host: s.host,
        });
    }

    const project: ProjectManifest = {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: `grove-${spec.id}`,
        contentHash: spec.id,
        settings: {
            simRate: spec.simRate ?? SIM_RATE,
            sendRate: spec.sendRate ?? SEND_RATE,
            maxPlayers: spec.maxPlayers ?? 4,
            bounds: spec.bounds ?? WORLD_BOUNDS,
            regions: [...(spec.regions ?? [])],
        },
        assets: [...(spec.assets ?? [DISC_ASSET])],
        scriptModules: [...byPath.values()],
        templates: [...(spec.templates ?? [])],
        entities: [...(spec.entities ?? [])],
        gameScripts: [...(spec.gameScripts ?? [])],
    };

    // A `ServerScript` linked into a page would be authoritative code on the untrusted end, so the
    // client half takes the synced and client classes and nothing else.
    return {
        project,
        server: ScriptRegistry.from<ScriptId>(
            scripts.filter((s) => s.location !== 'client').map(entryOf),
        ),
        client: ScriptRegistry.from<ScriptId>(
            scripts.filter((s) => s.location !== 'server').map(entryOf),
        ),
        bindings: spec.bindings ?? [],
        screens: spec.screens ?? [],
        simRate: spec.simRate ?? SIM_RATE,
        ...(spec.mirrorWidget === undefined ? {} : { mirrorWidget: spec.mirrorWidget }),
    };
}
