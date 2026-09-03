// The authored project: one file describing the whole game, as an editor would save it.
//
// This is the input BOTH ends take. The server validates it, narrows it to the world a runtime is
// built from and to the manifest a renderer draws, and derives the identity the handshake compares;
// `createClient` derives the same identity from the same object, which is what makes a mismatch a
// refused join rather than two ends quietly running different games.
//
// It holds ids and no classes, so it is safe in both halves' bundles — and it carries no decorator,
// which is what lets a runner that does not lower them read it from source.

import { PROJECT_FORMAT_VERSION, assetId, scriptId, templateId } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import {
    ASSET_DISC,
    ASSET_DISC_PIXELS,
    ASSET_DISC_URL,
    AVATAR_STEP,
    BONUS_BOUNDS,
    MAX_PLAYERS,
    ORB_INTERVAL,
    PROJECT_HASH,
    PROJECT_ID,
    REGION_BONUS,
    SCRIPT_COLLECTOR,
    SCRIPT_LEDGER,
    SCRIPT_MOVER,
    SCRIPT_ORB,
    SCRIPT_PANEL,
    SCRIPT_PROFILE,
    SCRIPT_RULES,
    SEND_RATE,
    SIM_RATE,
    TEMPLATE_AVATAR,
    TEMPLATE_ORB,
    TEMPLATE_SHADOW,
    WORLD,
} from './globals.js';

export const PROJECT: ProjectManifest = {
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: PROJECT_ID,
    contentHash: PROJECT_HASH,

    settings: {
        simRate: SIM_RATE,
        sendRate: SEND_RATE,
        maxPlayers: MAX_PLAYERS,
        bounds: WORLD,
        regions: [{ name: REGION_BONUS, bounds: BONUS_BOUNDS }],
    },

    assets: [
        { id: assetId(ASSET_DISC), kind: 'texture', url: ASSET_DISC_URL, meta: ASSET_DISC_PIXELS },
    ],

    // One entry per source module under `scripts/`. `path` and `export` are how a loader reaches
    // the class without parsing the module; `location` and `host` are restated from the base class
    // and the type parameter it was written with, so the validator can refuse an illegal attachment
    // from this file alone.
    scriptModules: [
        {
            path: 'src/scripts/rules.ts',
            scripts: [
                { id: scriptId(SCRIPT_RULES), export: 'Rules', location: 'server', host: 'game' },
            ],
        },
        // Player-hosted, and named in no attachment list below: a player is not a tray row, so
        // `Rules` attaches it at the join. Declaring it is what makes this file the whole inventory.
        {
            path: 'src/scripts/ledger.ts',
            scripts: [
                { id: scriptId(SCRIPT_LEDGER), export: 'Ledger', location: 'server', host: 'game' },
            ],
        },
        {
            path: 'src/scripts/profile.ts',
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
            path: 'src/scripts/mover.ts',
            scripts: [
                { id: scriptId(SCRIPT_MOVER), export: 'Mover', location: 'synced', host: 'entity' },
            ],
        },
        {
            path: 'src/scripts/collector.ts',
            scripts: [
                {
                    id: scriptId(SCRIPT_COLLECTOR),
                    export: 'Collector',
                    location: 'server',
                    host: 'entity',
                },
            ],
        },
        {
            path: 'src/scripts/orb.ts',
            scripts: [
                { id: scriptId(SCRIPT_ORB), export: 'Orb', location: 'server', host: 'entity' },
            ],
        },
        {
            path: 'src/scripts/panel.ts',
            scripts: [
                { id: scriptId(SCRIPT_PANEL), export: 'Panel', location: 'client', host: 'screen' },
            ],
        },
    ],

    templates: [
        {
            id: templateId(TEMPLATE_ORB),
            visual: { kind: 'sprite', texture: assetId(ASSET_DISC), tint: 0x8fd694 },
            scripts: [{ script: scriptId(SCRIPT_ORB) }],
        },
        {
            id: templateId(TEMPLATE_AVATAR),
            visual: { kind: 'sprite', texture: assetId(ASSET_DISC) },
            // `Mover` rides the template rather than an `addScript` in the join handler, so the
            // avatar is running it before that handler returns — and the resulting `attach` op is
            // what tells the browser to attach its own copy and predict.
            scripts: [
                { script: scriptId(SCRIPT_MOVER), props: { step: AVATAR_STEP } },
                { script: scriptId(SCRIPT_COLLECTOR) },
            ],
            // One spawn key, two entities: the roster mints the whole subtree, so a respawn never
            // has to remember to parent a shadow by hand.
            children: [
                {
                    template: templateId(TEMPLATE_SHADOW),
                    transform: { y: -10, scale: 1.15, opacity: 0.3, layer: -1 },
                },
            ],
        },
        {
            id: templateId(TEMPLATE_SHADOW),
            visual: { kind: 'sprite', texture: assetId(ASSET_DISC), tint: 0x1b2a20 },
            scripts: [],
        },
    ],

    // The placed world: a bare marker at the middle of the bonus region, so the boot path that
    // instantiates entities from the file has something to build and every joiner is owed it in
    // their snapshot.
    entities: [
        {
            id: 'bonus-pip',
            template: templateId(TEMPLATE_SHADOW),
            parent: null,
            transform: { x: 0, y: 0, scale: 2, opacity: 0.2, layer: -10 },
            tags: [],
            scripts: [],
        },
    ],

    // A whole attachment, not a bare class: the drop cadence is an inspector value, so it rides the
    // manifest rather than being read out of a module the browser cannot see.
    gameScripts: [
        { script: scriptId(SCRIPT_RULES), props: { orbInterval: ORB_INTERVAL } },
        { script: scriptId(SCRIPT_LEDGER) },
    ],
};
