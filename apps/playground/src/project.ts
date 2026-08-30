// The authored project: one file describing the whole game, as an editor would save it.
//
// This is the input BOTH ends take. `GameInstance` validates it, narrows it to the world a runtime
// is built from and to the manifest a renderer draws, and derives the identity the handshake
// compares; `createClient` derives the same identity from the same object, which is what makes a
// mismatch a refused join rather than two ends quietly running different games.
//
// It holds ids and no classes, and it imports nothing from `scripts/` but that file's globals. A
// `ScriptId` here is resolved through the `ScriptRegistry` each half passes separately — the
// server's holds every class, the browser's only what may run there — so this one file is safe in
// both bundles. It is compiled by both projects for that reason, which is also why it carries no
// decorator: only `tsc` lowers those, and Vite reads this from source.

import { assetId, scriptId, templateId } from '@platform/project';
import { PROJECT_FORMAT_VERSION } from '@platform/project';
import type { ProjectManifest, TemplateRecord } from '@platform/project';
import {
    AVATAR_SCALE,
    AVATAR_SHADOW_TEMPLATE,
    AVATAR_STEP,
    AVATAR_TEMPLATE,
    BONUS_BOUNDS,
    COMPOST_BOUNDS,
    LEAF_ASSET,
    LEAF_INTERVAL,
    LEAF_PIXELS,
    LEAF_TEMPLATE,
    LEAF_URL,
    MARKER_ASSET,
    MARKER_PIXELS,
    MARKER_URL,
    MAX_PLAYERS,
    PLAYER_TINTS,
    REGION_BONUS,
    REGION_COMPOST,
    RESULTS_SECONDS,
    ROUND_SECONDS,
    SCRIPT_CLICKER,
    SCRIPT_HARVESTER,
    SCRIPT_LEAF,
    SCRIPT_LOBBY,
    SCRIPT_PROFILE,
    SCRIPT_RULES,
    SCRIPT_RUNNER,
    WORLD,
    markerTemplate,
} from './scripts/globals.js';

/** What this project IS, on the handshake. Both composition roots derive their claim from these. */
export const PROJECT_ID = 'grove-playground';

/**
 * The build of this file and everything it names, bumped by hand when it changes incompatibly.
 *
 * A tab left open across a `dev` restart holds the old bundle, and the constants in
 * `scripts/globals.ts` — action names, templates, script ids, tints, the world extent, the match
 * rules — are what both ends agree on. A mismatch used to show up as leaves drawn in the wrong
 * place; now the server refuses the join and the tab says to reload.
 */
export const PROJECT_HASH = '4';

/** Ticks per simulated second. */
export const SIM_RATE = 60;

/**
 * Broadcasts per second — the package default, and the rate the client interpolates over.
 *
 * A leaf is moved by a server script, so nothing local predicts it; the client draws it one send
 * interval behind and walks between the two poses either side of that moment. Raising this to match
 * `SIM_RATE` buys nothing but `1 + connections` encodes per tick instead of per third tick.
 */
export const SEND_RATE = 20;

/** The zone pips: art with no behaviour, placed once and never moved. */
const ZONE_PIVOT_TEMPLATE = 'zone-pivot';
const ZONE_BONUS_TEMPLATE = 'zone-bonus';
const ZONE_COMPOST_TEMPLATE = 'zone-compost';

/** Dim enough to read as ground marking rather than as something to catch. */
const ZONE_OPACITY = 0.22;
const ZONE_SCALE = 3;
const ZONE_LAYER = -10;
const ZONE_BONUS_TINT = 0x2f6f4e;
const ZONE_COMPOST_TINT = 0x6b4a2f;

/** Where each zone's three pips sit, as a fraction of the world's height. */
const ZONE_ROWS = [0.55, 0, -0.55] as const;

/**
 * One badge template per player slot, differing only in tint.
 *
 * A template is the only per-entity route a colour has to the wire, so "who is this leaf ripe for"
 * has to be a template choice rather than a field.
 */
const badgeTemplates: TemplateRecord[] = PLAYER_TINTS.map((tint, slot) => ({
    id: templateId(markerTemplate(slot)),
    visual: { kind: 'sprite', texture: assetId(MARKER_ASSET), tint },
    scripts: [],
}));

/**
 * The pips of one zone: a bare pivot with three sprites beneath it.
 *
 * Placed entities rather than a template subtree, because a zone is one arrangement in one world
 * and a template is a thing spawned repeatedly — and it is what gives the placed-world path
 * something to build, parents before children, at boot.
 */
function zonePips(
    prefix: string,
    template: string,
    bounds: { left: number; right: number },
): ProjectManifest['entities'] {
    const x = (bounds.left + bounds.right) / 2;
    const pivot = {
        id: `${prefix}-pivot`,
        template: templateId(ZONE_PIVOT_TEMPLATE),
        parent: null,
        transform: { x, y: 0 },
        tags: [],
        scripts: [],
    };
    const pips = ZONE_ROWS.map((row, index) => ({
        id: `${prefix}-${index}`,
        template: templateId(template),
        parent: pivot.id,
        // Local to the pivot: hierarchy carries position only, so the scale and opacity below are
        // this node's own rather than inherited.
        transform: {
            x: 0,
            y: row * WORLD.top,
            scale: ZONE_SCALE,
            opacity: ZONE_OPACITY,
            layer: ZONE_LAYER,
        },
        tags: [],
        scripts: [],
    }));
    return [pivot, ...pips];
}

/**
 * The whole game, as one file.
 *
 * `scriptModules` declares every class this project may attach, with the location and host it was
 * written for — that is what lets `validate` refuse an illegal attachment from the manifest alone,
 * before a module is loaded or a world is built. Player-hosted scripts appear here and in no
 * attachment list: a player is not a tray row, so `Clicker` and `Profile` are attached at the join.
 */
export const PROJECT: ProjectManifest = {
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: PROJECT_ID,
    // The digest the handshake compares. Hand-stamped here, because nothing in this app builds the
    // file — a real editor would write it, and both ends read it from this one place either way.
    contentHash: PROJECT_HASH,

    settings: {
        simRate: SIM_RATE,
        sendRate: SEND_RATE,
        maxPlayers: MAX_PLAYERS,
        bounds: WORLD,
        regions: [
            { name: REGION_BONUS, bounds: BONUS_BOUNDS },
            { name: REGION_COMPOST, bounds: COMPOST_BOUNDS },
        ],
    },

    // Fetched by the browser, never by the server, and the client admits only `http:`, `https:` and
    // relative paths — so these resolve against the origin that served the page.
    assets: [
        { id: assetId(LEAF_ASSET), kind: 'texture', url: LEAF_URL, meta: LEAF_PIXELS },
        { id: assetId(MARKER_ASSET), kind: 'texture', url: MARKER_URL, meta: MARKER_PIXELS },
    ],

    // One entry per source module under `scripts/`, which is one script per file. `path` and
    // `export` are how a loader reaches the class without parsing the module; `location` and `host`
    // are restated from the base class and the type parameter it was written with, so `validate`
    // can refuse an illegal attachment from this file alone.
    scriptModules: [
        {
            path: 'src/scripts/game/rules.ts',
            scripts: [
                { id: scriptId(SCRIPT_RULES), export: 'Rules', location: 'server', host: 'game' },
            ],
        },
        // Player-hosted, and named in no attachment list below: a player is not a tray row, so
        // `Rules` attaches these two at the join. Declaring them is what makes this file the whole
        // inventory of what the project can run.
        {
            path: 'src/scripts/players/clicker.ts',
            scripts: [
                {
                    id: scriptId(SCRIPT_CLICKER),
                    export: 'Clicker',
                    location: 'server',
                    host: 'player',
                },
            ],
        },
        {
            path: 'src/scripts/players/profile.ts',
            scripts: [
                {
                    id: scriptId(SCRIPT_PROFILE),
                    export: 'Profile',
                    location: 'server',
                    host: 'player',
                },
            ],
        },
        {
            path: 'src/scripts/templates/avatar/runner.ts',
            scripts: [
                {
                    id: scriptId(SCRIPT_RUNNER),
                    export: 'Runner',
                    location: 'synced',
                    host: 'entity',
                },
            ],
        },
        {
            path: 'src/scripts/templates/avatar/harvester.ts',
            scripts: [
                {
                    id: scriptId(SCRIPT_HARVESTER),
                    export: 'Harvester',
                    location: 'server',
                    host: 'entity',
                },
            ],
        },
        {
            path: 'src/scripts/templates/leaf/leaf.ts',
            scripts: [
                { id: scriptId(SCRIPT_LEAF), export: 'Leaf', location: 'server', host: 'entity' },
            ],
        },
        {
            path: 'src/scripts/screens/lobby.ts',
            scripts: [
                {
                    id: scriptId(SCRIPT_LOBBY),
                    export: 'LobbyScreen',
                    location: 'client',
                    host: 'screen',
                },
            ],
        },
    ],

    templates: [
        {
            id: templateId(LEAF_TEMPLATE),
            visual: { kind: 'sprite', texture: assetId(LEAF_ASSET) },
            // Every leaf ever spawned carries these before any `@onStart` runs, which is what makes
            // ripening and composting a property of being a leaf rather than of the spawn site.
            scripts: [{ script: scriptId(SCRIPT_LEAF) }],
        },
        {
            id: templateId(AVATAR_TEMPLATE),
            visual: { kind: 'sprite', texture: assetId(MARKER_ASSET) },
            // `Runner` rides the template rather than an `addScript` in the join handler, so the
            // avatar is running it before that handler returns — and the resulting `attach` op is
            // what tells the browser to attach its own copy and predict.
            scripts: [
                // The step rides the attachment, so it reaches the browser on the `attach` op and
                // both ends replay the same number without a second constant to keep in step.
                { script: scriptId(SCRIPT_RUNNER), props: { step: AVATAR_STEP } },
                { script: scriptId(SCRIPT_HARVESTER) },
            ],
            // One spawn key, two entities: the roster mints the whole subtree, so nothing has to
            // remember to parent a shadow by hand every time a player respawns. The scale is the
            // child's own — only position and visibility inherit — and is a shade wider than the
            // body it sits under, which is what makes it read as a shadow.
            children: [
                {
                    template: templateId(AVATAR_SHADOW_TEMPLATE),
                    transform: { y: -14, scale: AVATAR_SCALE * 1.15, opacity: 0.3, layer: -1 },
                },
            ],
        },
        {
            id: templateId(AVATAR_SHADOW_TEMPLATE),
            visual: { kind: 'sprite', texture: assetId(MARKER_ASSET), tint: 0x1b2a20 },
            scripts: [],
        },
        { id: templateId(ZONE_PIVOT_TEMPLATE), visual: { kind: 'group' }, scripts: [] },
        {
            id: templateId(ZONE_BONUS_TEMPLATE),
            visual: {
                kind: 'sprite',
                texture: assetId(MARKER_ASSET),
                tint: ZONE_BONUS_TINT,
                neverCull: true,
            },
            scripts: [],
        },
        {
            id: templateId(ZONE_COMPOST_TEMPLATE),
            visual: {
                kind: 'sprite',
                texture: assetId(MARKER_ASSET),
                tint: ZONE_COMPOST_TINT,
                neverCull: true,
            },
            scripts: [],
        },
        ...badgeTemplates,
    ],

    entities: [
        ...zonePips('bonus', ZONE_BONUS_TEMPLATE, BONUS_BOUNDS),
        ...zonePips('compost', ZONE_COMPOST_TEMPLATE, COMPOST_BOUNDS),
    ],

    // Whole attachments, not bare classes: the round length and the results dwell are inspector
    // values, so they ride the manifest rather than being read out of a module the browser cannot
    // see. `applyProps` writes them between construction and the `@serverState` hoist.
    gameScripts: [
        {
            script: scriptId(SCRIPT_RULES),
            props: {
                roundSeconds: ROUND_SECONDS,
                resultsSeconds: RESULTS_SECONDS,
                leafInterval: LEAF_INTERVAL,
            },
        },
    ],
};
