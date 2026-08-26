// What a spawn key means: the scripts every instance of it carries, and the entities minted beneath
// it. Instantiating one is journaled as a single group, because a subtree whose ops crossed the wire
// in pieces would be applied against a world missing its own parents.

import type {
    EntityTransform,
    PlacedEntity,
    ResolvedAttachment,
    ResolvedTemplate,
    ScriptProps,
    TemplateId,
} from '@platform/project';
import { LoadError } from '../errors.js';
import type { EntityId } from '../ids.js';
import type { Entity } from '../runtime/entity.js';
import type { Runtime } from '../runtime/runtime.js';

export type { EntityTransform, PlacedEntity, ScriptProps };

/**
 * A template as the runtime holds it.
 *
 * `@platform/project`'s resolved narrowing rather than a parallel declaration: a template is an
 * authored thing, and a second shape here would be a guess at the one the editor saves. It carries
 * no visual, because core draws nothing — the art is keyed by the same `TemplateId` in the render
 * manifest, which is the client's to hold.
 */
export type TemplateDef = ResolvedTemplate;

/** One script a template attaches, with the class its id resolved to and the props it configured. */
export type TemplateAttachment = ResolvedAttachment;

/** A script class, as an attach site takes it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- attach accepts any host-typed class
export type AnyScriptClass = new (props?: ScriptProps) => any;

/**
 * Levels one instantiation may nest, and entities it may mint.
 *
 * A child names a template, so a subtree is a reference graph: a per-record child count bounds
 * nothing, and the depth bound is a stack bound on the walk below. `validate` refuses both faults in
 * a saved file; these hold for a registry assembled any other way.
 */
export const MAX_TEMPLATE_DEPTH = 8;
export const MAX_TEMPLATE_NODES = 256;

/**
 * The templates a world can spawn, by the key `game.spawn` names.
 *
 * A key with no entry is not an error: `spawn` mints one bare entity under it, which is what an
 * ad-hoc key has always done and what keeps a template a configuration rather than a requirement.
 */
export class TemplateRegistry {
    readonly #byId: ReadonlyMap<string, TemplateDef>;

    private constructor(byId: ReadonlyMap<string, TemplateDef>) {
        this.#byId = byId;
    }

    /** Builds a registry over a manifest's templates. A repeated id is fatal. */
    static from(defs: Iterable<TemplateDef>): TemplateRegistry {
        const byId = new Map<string, TemplateDef>();
        for (const def of defs) {
            if (byId.has(def.id)) throw new LoadError(`two templates claim the id "${def.id}"`);
            byId.set(def.id, def);
        }
        return new TemplateRegistry(byId);
    }

    get size(): number {
        return this.#byId.size;
    }

    has(id: string): boolean {
        return this.#byId.has(id);
    }

    get(id: string): TemplateDef | undefined {
        return this.#byId.get(id);
    }

    ids(): TemplateId[] {
        return [...this.#byId.keys()] as TemplateId[];
    }
}

/** Where an instantiation puts its root, and who owns every entity it mints. */
export interface InstantiateOptions {
    x?: number;
    y?: number;
    /** The owning player's id, inherited by the whole subtree — a badge belongs to its leaf's owner. */
    ownerId?: string;
    /** Extra tags on the root alone, applied before any `@onStart` could read them. */
    tags?: readonly string[];
    /** Attachments beyond the template's own, in this order after them. */
    scripts?: readonly TemplateAttachment[];
    /** Overrides the root's placement; a child's own offset always comes from the template. */
    transform?: EntityTransform;
}

/**
 * Mints a template's whole subtree and returns its root.
 *
 * Logical-now and journaled-as-one: every entity exists the moment it is minted, exactly as a bare
 * `spawn` does, and the group bounds only what crosses the wire — the ops of one instantiation are
 * applied together, in order, or not at all. That is the mirror of `destroy`, which is logical-now
 * and torn down at the end of the tick.
 */
export function instantiate(rt: Runtime, template: string, opts: InstantiateOptions = {}): Entity {
    const def = rt.templates?.get(template);
    const extra = opts.scripts ?? [];
    if (def === undefined && extra.length === 0 && (opts.tags ?? []).length === 0) {
        // A key the registry does not hold is one bare entity, which is what an ad-hoc spawn has
        // always been — and grouping a single op would put a boundary on the wire that bounds nothing.
        return spawnNode(rt, template, opts);
    }

    rt.channels.beginGroup();
    try {
        const root = spawnNode(rt, template, opts);
        const budget = { minted: 1 };
        attachAll(rt, root.entityId, def?.scripts ?? []);
        attachAll(rt, root.entityId, extra);
        for (const tag of opts.tags ?? []) root.tag(tag);
        if (def !== undefined) mintChildren(rt, root, def, 1, budget);
        return root;
    } finally {
        rt.channels.endGroup();
    }
}

/**
 * Builds the placed world a manifest declares, parents before children.
 *
 * One pass, because `validate` orders the records: a parent's row comes before its children's, so
 * the id map always holds the parent by the time a child names it.
 */
export function instantiatePlaced(rt: Runtime, entities: readonly PlacedEntity[]): void {
    const minted = new Map<string, Entity>();
    for (const record of entities) {
        const entity = instantiate(rt, record.template ?? '', {
            x: record.transform?.x ?? 0,
            y: record.transform?.y ?? 0,
            tags: record.tags,
            scripts: record.scripts,
            ...(record.transform === undefined ? {} : { transform: record.transform }),
        });
        minted.set(record.id, entity);
        if (record.parent === null) continue;
        const parent = minted.get(record.parent);
        // Rooted rather than refused: `validate` is what orders the records, and a manifest that
        // reached here out of order has one flat entity rather than no world at all.
        if (parent !== undefined) entity.attachTo(parent);
    }
}

function mintChildren(
    rt: Runtime,
    parent: Entity,
    def: TemplateDef,
    depth: number,
    budget: { minted: number },
): void {
    if (def.children.length === 0) return;
    if (depth >= MAX_TEMPLATE_DEPTH) {
        throw new LoadError(`template "${def.id}" nests deeper than ${MAX_TEMPLATE_DEPTH}`);
    }
    const ownerId = rt.entities.record(parent.entityId)?.ownerId ?? '';
    for (const child of def.children) {
        budget.minted += 1;
        if (budget.minted > MAX_TEMPLATE_NODES) {
            throw new LoadError(
                `template "${def.id}" mints more than ${MAX_TEMPLATE_NODES} entities`,
            );
        }
        const childDef = rt.templates?.get(child.template);
        // The offset is local to the parent node, which is all hierarchy carries.
        const entity = spawnNode(rt, child.template, {
            x: child.transform?.x ?? 0,
            y: child.transform?.y ?? 0,
            ownerId,
            ...(child.transform === undefined ? {} : { transform: child.transform }),
        });
        attachAll(rt, entity.entityId, childDef?.scripts ?? []);
        // After the scripts, so the reparent op follows this node's own attach ops and a client
        // rebuilding the group never parents an entity whose scripts it has not been told about.
        entity.attachTo(parent);
        if (childDef !== undefined) mintChildren(rt, entity, childDef, depth + 1, budget);
    }
}

function spawnNode(rt: Runtime, template: string, at: InstantiateOptions): Entity {
    const entity = rt.entityManager.spawn(template, at.x ?? 0, at.y ?? 0, at.ownerId ?? '');
    applyTransform(rt, entity.entityId, at.transform);
    return entity;
}

function attachAll(rt: Runtime, id: EntityId, attachments: readonly TemplateAttachment[]): void {
    for (const attachment of attachments) {
        rt.wiring?.attachToEntity(id, attachment.klass as AnyScriptClass, attachment.props);
    }
}

/** Every authored field but x and y, which `spawn` has already written. */
function applyTransform(rt: Runtime, id: EntityId, transform: EntityTransform | undefined): void {
    if (transform === undefined) return;
    const t = rt.transforms;
    if (transform.z !== undefined) t.setPosition(id, t.posX(id), t.posY(id), transform.z);
    if (transform.rotation !== undefined) t.setRotation(id, transform.rotation);
    if (transform.scale !== undefined) t.setScale(id, transform.scale);
    if (transform.opacity !== undefined) t.setOpacity(id, transform.opacity);
    if (transform.layer !== undefined) t.setLayer(id, transform.layer);
}
