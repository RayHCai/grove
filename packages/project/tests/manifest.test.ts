import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@platform/transport';
import type { Migration, MigrationChain, ProjectManifest, ScriptClass } from '../src/index.js';
import {
    PROJECT_FORMAT_VERSION,
    ProjectFormatError,
    assetId,
    migrate,
    scriptId,
    templateId,
    toGameManifest,
    toRenderManifest,
    validate,
} from '../src/index.js';

const project: ProjectManifest = {
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: 'proj_7f3a',
    contentHash: 'sha256:0a1b2c',
    settings: {
        simRate: 60,
        sendRate: 20,
        maxPlayers: 8,
        bounds: { left: -400, right: 400, top: 300, bottom: -300 },
        regions: [{ name: 'pit', bounds: { left: -50, right: 50, top: -100, bottom: -300 } }],
    },
    assets: [
        {
            id: assetId('coin-art'),
            kind: 'texture',
            url: '/art/coin.png',
            meta: { width: 16, height: 16 },
        },
        { id: assetId('chime'), kind: 'audio', url: '/audio/chime.ogg' },
    ],
    scriptModules: [
        {
            path: 'src/pickup.ts',
            scripts: [
                { id: scriptId('Pickup'), export: 'Pickup', location: 'synced', host: 'entity' },
                { id: scriptId('Rules'), export: 'Rules', location: 'server', host: 'game' },
            ],
        },
    ],
    templates: [
        {
            id: templateId('coin'),
            visual: { kind: 'sprite', texture: assetId('coin-art'), anchorX: 0.5, anchorY: 0.5 },
            scripts: [{ script: scriptId('Pickup'), props: { value: 10 } }],
        },
        { id: templateId('spawner'), visual: { kind: 'group' }, scripts: [] },
    ],
    entities: [
        {
            id: 'e-root',
            template: templateId('spawner'),
            parent: null,
            tags: ['spawner'],
            scripts: [],
        },
        {
            id: 'e-coin',
            template: templateId('coin'),
            parent: 'e-root',
            transform: { x: 32, y: 8, layer: 2 },
            tags: ['pickup'],
            scripts: [],
        },
    ],
    gameScripts: [{ script: scriptId('Rules') }],
};

/** A parsed copy, so a mutation reaches only the case that made it. */
function draft(): ProjectManifest {
    return JSON.parse(JSON.stringify(project)) as ProjectManifest;
}

function refusal(value: unknown): ProjectFormatError {
    try {
        validate(value);
    } catch (error) {
        if (error instanceof ProjectFormatError) return error;
        throw error;
    }
    throw new Error('validate accepted a manifest it should have refused');
}

describe('validate', () => {
    it('accepts a manifest that survived a file round-trip, and returns what it was handed', () => {
        const parsed: unknown = JSON.parse(JSON.stringify(project));
        const validated = validate(parsed);
        expect(validated).toEqual(project);
        expect(validated).toBe(parsed);
    });

    it('refuses a formatVersion migrate has not moved forward yet', () => {
        const stale = draft();
        stale.formatVersion = PROJECT_FORMAT_VERSION + 1;
        expect(refusal(stale).path).toBe('formatVersion');
    });

    it('refuses a child placed before its parent', () => {
        const reordered = draft();
        reordered.entities.reverse();
        expect(refusal(reordered).path).toBe('entities[0].parent');
    });

    it('refuses a second record claiming an id', () => {
        const duplicated = draft();
        duplicated.templates[1]!.id = templateId('coin');
        expect(refusal(duplicated).path).toBe('templates[1].id');
    });

    it('refuses a sprite whose texture names no asset', () => {
        const dangling = draft();
        const visual = dangling.templates[0]!.visual;
        if (visual.kind === 'sprite') visual.texture = assetId('missing-art');
        expect(refusal(dangling).path).toBe('templates[0].visual.texture');
    });

    it('refuses an entity whose template names no record', () => {
        const dangling = draft();
        dangling.entities[1]!.template = templateId('ghost');
        expect(refusal(dangling).path).toBe('entities[1].template');
    });

    it('accepts a subtree naming a template declared further down the array', () => {
        // Unlike an entity's parent, which is ordered so a loader builds the hierarchy in one pass:
        // a template graph has no such order, and two templates may name each other's siblings.
        const forward = draft();
        forward.templates[0]!.children = [{ template: templateId('spawner') }];
        expect(() => validate(forward)).not.toThrow();
    });

    it('refuses a subtree child naming no template', () => {
        const dangling = draft();
        dangling.templates[0]!.children = [{ template: templateId('ghost') }];
        expect(refusal(dangling).path).toBe('templates[0].children[0].template');
    });

    it('refuses a template that reaches itself, however long the loop is', () => {
        const looped = draft();
        looped.templates[0]!.children = [{ template: templateId('spawner') }];
        looped.templates[1]!.children = [{ template: templateId('coin') }];
        // Instantiating either mints entities until memory stops it, which is not an error a
        // runtime can report usefully.
        expect(refusal(looped).message).toContain('contains itself');
    });

    it('accepts a diamond, where two children name one leaf template', () => {
        // Not a cycle: the walk tracks the path it is on, not every template it has ever seen.
        const shared = draft();
        shared.templates[1]!.children = [
            { template: templateId('coin') },
            { template: templateId('coin'), transform: { x: 8 } },
        ];
        expect(() => validate(shared)).not.toThrow();
    });

    it('refuses a script attached to the wrong kind of host', () => {
        const mishosted = draft();
        mishosted.templates[1]!.scripts = [{ script: scriptId('Rules') }];
        expect(refusal(mishosted).path).toBe('templates[1].scripts[0].script');
    });

    it('refuses one class attached twice to one host', () => {
        const doubled = draft();
        doubled.gameScripts = [{ script: scriptId('Rules') }, { script: scriptId('Rules') }];
        expect(refusal(doubled).path).toBe('gameScripts[1].script');
    });

    it('refuses a reserved key in a props map rather than stripping it', () => {
        const polluted = draft();
        polluted.templates[0]!.scripts[0]!.props = JSON.parse(
            '{"nested": {"__proto__": {"owned": true}}}',
        ) as Record<string, JsonValue>;
        expect(refusal(polluted).path).toBe('templates[0].scripts[0].props.nested.__proto__');
    });

    it('refuses a rate that would stop the world stepping', () => {
        const stalled = draft();
        stalled.settings.simRate = 0;
        expect(refusal(stalled).path).toBe('settings.simRate');
    });

    it('refuses an edge that is not a finite number', () => {
        const unbounded = draft();
        (unbounded.settings.bounds as { right: unknown }).right = 'far';
        expect(refusal(unbounded).path).toBe('settings.bounds.right');
    });

    it('names the manifest itself when it is not an object at all', () => {
        expect(refusal([]).path).toBe('');
    });
});

describe('toGameManifest', () => {
    class Rules {
        readonly declaredAs = 'Rules';
    }

    const resolve = (id: string): ScriptClass | undefined => (id === 'Rules' ? Rules : undefined);

    it('carries the build-time settings and drops what a runtime cannot act on', () => {
        expect(toGameManifest(project, { role: 'server', scripts: resolve })).toEqual({
            role: 'server',
            simRate: 60,
            bounds: project.settings.bounds,
            regions: project.settings.regions,
            assets: [
                { key: 'coin-art', kind: 'texture', meta: { width: 16, height: 16 } },
                { key: 'chime', kind: 'audio' },
            ],
            // No visual: a runtime draws nothing, so the art is `toRenderManifest`'s alone.
            templates: [
                { id: 'coin', scripts: [], children: [] },
                { id: 'spawner', scripts: [], children: [] },
            ],
            entities: [
                {
                    id: 'e-root',
                    template: 'spawner',
                    parent: null,
                    tags: ['spawner'],
                    scripts: [],
                },
                {
                    id: 'e-coin',
                    template: 'coin',
                    parent: 'e-root',
                    transform: { x: 32, y: 8, layer: 2 },
                    tags: ['pickup'],
                    scripts: [],
                },
            ],
            // The id rides alongside the class: a runtime constructs the class and the wire names
            // the id, and dropping either would cost the other's job.
            gameScripts: [{ script: 'Rules', klass: Rules }],
        });
    });

    it('resolves a template attachment to its class and keeps the props it was configured with', () => {
        const withPickup = toGameManifest(project, {
            role: 'server',
            scripts: (id) => (id === 'Pickup' ? Rules : undefined),
        });
        expect(withPickup.templates[0]?.scripts).toEqual([
            { script: 'Pickup', klass: Rules, props: { value: 10 } },
        ]);
    });

    it('carries a template subtree through as the reference graph it is', () => {
        const nested = draft();
        nested.templates[1] = {
            ...nested.templates[1]!,
            children: [{ template: templateId('coin'), transform: { y: 12 } }],
        };
        const manifest = toGameManifest(validate(nested), { role: 'server', scripts: resolve });
        expect(manifest.templates[1]?.children).toEqual([
            { template: 'coin', transform: { y: 12 } },
        ]);
    });

    it('leaves an absent meta an absent KEY, never an explicit undefined', () => {
        const manifest = toGameManifest(project, { role: 'client', scripts: resolve });
        expect(Object.hasOwn(manifest.assets[1]!, 'meta')).toBe(false);
    });

    it('drops an attachment the resolver does not answer', () => {
        const manifest = toGameManifest(project, { role: 'server', scripts: () => undefined });
        expect(manifest.gameScripts).toEqual([]);
    });
});

describe('toRenderManifest', () => {
    it('keys every visual by the template entities spawn under, and keeps the urls', () => {
        expect(toRenderManifest(project)).toEqual({
            assets: [
                {
                    key: 'coin-art',
                    kind: 'texture',
                    url: '/art/coin.png',
                    meta: { width: 16, height: 16 },
                },
                { key: 'chime', kind: 'audio', url: '/audio/chime.ogg' },
            ],
            templates: [
                {
                    template: 'coin',
                    kind: 'sprite',
                    texture: 'coin-art',
                    anchorX: 0.5,
                    anchorY: 0.5,
                },
                { template: 'spawner', kind: 'group' },
            ],
        });
    });
});

describe('migrate', () => {
    it('is a no-op at the current version', () => {
        expect(migrate(project)).toEqual(project);
    });

    it('walks every step in order and stamps the version itself', () => {
        const walked: number[] = [];
        const rename: Migration = (p) => {
            walked.push(1);
            return { ...p, projectId: 'renamed' };
        };
        // A step that stamps a version of its own is overwritten by the walk, which is what makes
        // a step that forgets to stamp one equally safe.
        const misstamp: Migration = (p) => {
            walked.push(2);
            return { ...p, formatVersion: 99 };
        };
        const chain: MigrationChain = {
            to: PROJECT_FORMAT_VERSION + 2,
            steps: new Map<number, Migration>([
                [PROJECT_FORMAT_VERSION, rename],
                [PROJECT_FORMAT_VERSION + 1, misstamp],
            ]),
        };

        const migrated = migrate(project, chain) as Record<string, unknown>;
        expect(walked).toEqual([1, 2]);
        expect(migrated['projectId']).toBe('renamed');
        expect(migrated['formatVersion']).toBe(PROJECT_FORMAT_VERSION + 2);
    });

    it('refuses a file written by a newer editor than this build reads', () => {
        const future = { ...project, formatVersion: PROJECT_FORMAT_VERSION + 1 };
        expect(() => migrate(future)).toThrow(ProjectFormatError);
    });

    it('refuses a version with no step to the next', () => {
        const chain: MigrationChain = { to: PROJECT_FORMAT_VERSION + 1, steps: new Map() };
        expect(() => migrate(project, chain)).toThrow(/no migration/);
    });

    it('stamps the copy it returns, never the file it was handed', () => {
        const chain: MigrationChain = {
            to: PROJECT_FORMAT_VERSION + 1,
            steps: new Map<number, Migration>([[PROJECT_FORMAT_VERSION, (p) => p]]),
        };
        migrate(project, chain);
        expect(project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    });
});
