// Templates: what a spawn key means, and the one journal group an instantiation produces.

import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptId, TemplateId } from '@platform/project';
import { Target, Wallet } from '../dist/testkit/fixtures.js';
import { LoadError } from '../src/errors.js';
import { loadGame } from '../src/runtime/load-game.js';
import type { GameManifest } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { MAX_TEMPLATE_DEPTH, TemplateRegistry, instantiate } from '../src/world/templates.js';
import type { TemplateDef } from '../src/world/templates.js';
import type { SingleStructuralOp, StructuralOp } from '../src/state/channels.js';
import { entityKey } from '../src/runtime/hosts.js';

afterEach(() => clearRuntime());

const id = (key: string): TemplateId => key as TemplateId;
const sid = (key: string): ScriptId => key as ScriptId;

/** A turret with a barrel under it, and a sight under that — three levels, two references. */
const TURRET: TemplateDef[] = [
    {
        id: id('turret'),
        scripts: [{ script: sid('target'), klass: Target as never }],
        children: [{ template: id('barrel'), transform: { y: 12, layer: 1 } }],
    },
    { id: id('barrel'), scripts: [], children: [{ template: id('sight'), transform: { y: 4 } }] },
    { id: id('sight'), scripts: [], children: [] },
];

/** Names every class the fixtures use, which is what makes an `attach` op journalable at all. */
const SCRIPT_IDS = new Map<unknown, ScriptId>([
    [Target, sid('target')],
    [Wallet, sid('wallet')],
]);

function world(over: Partial<GameManifest> = {}) {
    return loadGame(
        { templates: TURRET, ...over },
        { scriptIdOf: (klass) => SCRIPT_IDS.get(klass) },
    );
}

/** Every op the journal holds, group boundaries flattened — for asserting order across both. */
function flatten(journal: readonly StructuralOp[]): SingleStructuralOp[] {
    return journal.flatMap((op) => (op.kind === 'group' ? op.ops : [op]));
}

describe('the registry answers what a spawn key means', () => {
    it('refuses two templates claiming one id, which would make a spawn ambiguous', () => {
        expect(() => TemplateRegistry.from([TURRET[0]!, TURRET[0]!])).toThrow(LoadError);
    });

    it('leaves a key it does not hold spawnable as one bare entity', () => {
        const rt = world();
        rt.channels.clear();
        const crate = rt.wired.gameInstance.spawn('crate', 3, 4);

        expect(crate.position.x).toBe(3);
        expect([...rt.instances.forHost(entityKey(crate.entityId as number))]).toHaveLength(0);
        // One op, not a group: a boundary around a single op bounds nothing and every consumer
        // would pay an unwrap for the ordinary spawn.
        expect(rt.channels.drainStructural()).toStrictEqual([
            { kind: 'spawn', id: crate.entityId, template: 'crate' },
        ]);
    });
});

describe('instantiating a template', () => {
    it('mints the whole subtree, parents before children, as ONE journaled group', () => {
        const rt = world();
        rt.channels.clear();
        const turret = rt.wired.gameInstance.spawn('turret', 100, 50);

        const journal = rt.channels.drainStructural();
        expect(journal).toHaveLength(1);
        const group = journal[0]!;
        expect(group.kind).toBe('group');
        if (group.kind !== 'group') throw new Error('unreachable');

        // Depth-first: each node is spawned and hung off its parent before its own children exist,
        // so a client applying this verbatim never parents to an id it does not hold.
        expect(group.ops.map((op) => op.kind)).toStrictEqual([
            'spawn',
            'attach',
            'spawn',
            'reparent',
            'spawn',
            'reparent',
        ]);
        const spawns = group.ops.filter((op) => op.kind === 'spawn');
        expect(spawns.map((op) => op.template)).toStrictEqual(['turret', 'barrel', 'sight']);
        expect(spawns[0]?.id).toBe(turret.entityId);
    });

    it('places the root at the spawn point and every child at its own local offset', () => {
        const rt = world();
        const turret = rt.wired.gameInstance.spawn('turret', 100, 50);
        const barrel = turret.children[0]!;
        const sight = barrel.children[0]!;

        expect([turret.position.x, turret.position.y]).toStrictEqual([100, 50]);
        // Local to the parent, which is all hierarchy carries — not 62.
        expect(barrel.position.y).toBe(12);
        expect(barrel.layer).toBe(1);
        expect(sight.position.y).toBe(4);
    });

    it('attaches the template’s scripts before anything could read the entity', () => {
        const rt = world();
        const turret = rt.wired.gameInstance.spawn('turret', 0, 0);
        const attached = [...rt.instances.forHost(entityKey(turret.entityId as number))];
        expect(attached.map((si) => si.className)).toStrictEqual(['Target']);
        // Hoisted onto the host too, so `entity.health` and `this.health` are one value.
        expect((turret as unknown as { health: number }).health).toBe(3);
    });

    it('gives every entity in the subtree the root’s owner', () => {
        const rt = world();
        const turret = instantiate(rt, 'turret', { ownerId: 'p1' });
        const barrel = turret.children[0]!;
        expect(rt.entities.record(barrel.entityId)?.ownerId).toBe('p1');
    });

    it('journals an attach naming the id the bundle stamped, never a class name', () => {
        const rt = world();
        rt.channels.clear();
        const turret = rt.wired.gameInstance.spawn('turret', 0, 0);
        const attach = flatten(rt.channels.drainStructural()).find((op) => op.kind === 'attach');
        expect(attach).toStrictEqual({
            kind: 'attach',
            id: turret.entityId,
            script: 'target',
        });
    });

    it('journals no attach for a class the bundle never stamped', () => {
        const rt = loadGame({ templates: TURRET });
        rt.channels.clear();
        rt.wired.gameInstance.spawn('turret', 0, 0);
        // Attached locally all the same: the op names an id, and nothing on the wire names a class.
        expect(flatten(rt.channels.drainStructural()).some((op) => op.kind === 'attach')).toBe(
            false,
        );
        expect([...rt.instances.all()]).toHaveLength(1);
    });

    it('refuses a subtree deeper than the bound, which a cycle reaches first', () => {
        const looped: TemplateDef[] = [
            { id: id('a'), scripts: [], children: [{ template: id('b') }] },
            { id: id('b'), scripts: [], children: [{ template: id('a') }] },
        ];
        const rt = loadGame({ templates: looped });
        expect(() => instantiate(rt, 'a')).toThrow(
            new RegExp(`nests deeper than ${MAX_TEMPLATE_DEPTH}`),
        );
    });
});

describe('a group is a replication boundary, not a visibility one', () => {
    it('leaves every entity addressable the moment it is minted', () => {
        const rt = world();
        // Inside the same synchronous call the group is still open, and `spawn` has already
        // returned live handles — the mirror of destroy, which is logical-now and torn down later.
        const turret = rt.wired.gameInstance.spawn('turret', 0, 0);
        expect(turret.alive).toBe(true);
        expect(rt.entities.liveIds()).toHaveLength(3);
        expect(rt.wired.gameInstance.entities).toHaveLength(3);
    });

    it('flattens a nested instantiation into one boundary rather than one per level', () => {
        const rt = world();
        rt.channels.clear();
        rt.wired.gameInstance.spawn('turret', 0, 0);
        const journal = rt.channels.drainStructural();
        // Both child templates opened their own group and neither produced an op: the whole
        // subtree is one instantiation, and a receiver gains nothing from being told where the
        // inner one started. The shape holds it too — a group's ops are single ops, never groups.
        expect(journal).toHaveLength(1);
        expect(flatten(journal)).toHaveLength(6);
    });
});

describe('the placed world is built before any @onStart', () => {
    it('instantiates each record, parents before children, through the same path', () => {
        const rt = world({
            entities: [
                {
                    id: 'e-root',
                    template: id('sight'),
                    parent: null,
                    tags: ['anchor'],
                    scripts: [],
                },
                {
                    id: 'e-turret',
                    template: id('turret'),
                    parent: 'e-root',
                    transform: { x: 20, y: 5 },
                    tags: [],
                    scripts: [{ script: sid('wallet'), klass: Wallet as never }],
                },
            ],
        });

        // One `sight` for the root, then the turret's own three.
        expect(rt.entities.liveIds()).toHaveLength(4);
        const root = rt.wired.gameInstance.find({ tag: 'anchor' })[0]!;
        const turret = root.children[0]!;
        expect(rt.entities.record(turret.entityId)?.template).toBe('turret');
        expect(turret.position.x).toBe(20);
        // The template's own attachment and the record's, in that order.
        expect(
            [...rt.instances.forHost(entityKey(turret.entityId as number))].map(
                (si) => si.className,
            ),
        ).toStrictEqual(['Target', 'Wallet']);
    });
});
