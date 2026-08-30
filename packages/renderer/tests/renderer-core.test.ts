// The per-frame contract, measured through a counting sink.
//
// `flush()` is the one method the client calls every frame, so what it does per node is a contract
// and not an implementation detail: a scene where nothing moved must cost nothing per node. A
// counting `SceneSink` is the only way to see that from outside — the headless backend's sink
// records nothing, and the Pixi one needs a GPU.

import { describe, it, expect } from 'vitest';
import { RendererCore, resolveInitOptions } from '../src/core/renderer-core.js';
import type { SceneSink } from '../src/core/scene-sink.js';
import type { NodeRecord } from '../src/node-store.js';
import type { Surface } from '../src/renderer.js';
import type { Size } from '@platform/math';

const DESIGN = { width: 800, height: 600 };

/** A sink that counts what the core asks of it. */
class CountingSink implements SceneSink {
    writes = 0;
    renderables = 0;
    readonly visible = new Map<Surface, boolean>();

    create(): void {}
    reparent(): void {}
    destroySubtree(): void {}
    setTexture(): void {}
    setText(): void {}
    setLayer(): void {}
    applyView(): void {}
    clearAll(): void {}

    write(): void {
        this.writes++;
    }

    setRenderable(): void {
        this.renderables++;
    }

    sizeOf(_index: number, record: NodeRecord): Size {
        return record.kind === 'group' ? { width: 0, height: 0 } : { width: 16, height: 16 };
    }

    surfaceVisible(surface: Surface): boolean {
        return this.visible.get(surface) ?? true;
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.visible.set(surface, visible);
    }

    reset(): void {
        this.writes = 0;
        this.renderables = 0;
    }
}

function core(): { core: RendererCore; sink: CountingSink } {
    const sink = new CountingSink();
    const config = resolveInitOptions({ design: DESIGN }, DESIGN, 1);
    return { core: new RendererCore(sink, config), sink };
}

/** `count` world sprites at the origin, all on screen. */
function populate(instance: RendererCore, count: number): void {
    for (let i = 0; i < count; i++) {
        instance.createNode({ kind: 'sprite', texture: 'block', position: { x: 0, y: 0 } });
    }
}

describe('RendererCore.flush is O(dirty), not O(scene)', () => {
    it('does no per-node work for a frame where nothing changed', () => {
        const { core: instance, sink } = core();
        populate(instance, 100);
        instance.flush();

        sink.reset();
        instance.flush();

        // Re-deciding a cull answer that cannot have changed is the whole cost this avoids.
        expect(sink.writes).toBe(0);
        expect(sink.renderables).toBe(0);
    });

    it('touches only the nodes a patch moved', () => {
        const { core: instance, sink } = core();
        populate(instance, 100);
        const moved = instance.createNode({ kind: 'sprite', texture: 'block' });
        instance.flush();

        sink.reset();
        instance.updateNodes([{ id: moved, position: { x: 10, y: 10 } }]);
        instance.flush();

        expect(sink.writes).toBe(1);
        expect(sink.renderables).toBe(1);
    });

    it('reconsiders every node when the camera moves', () => {
        const { core: instance, sink } = core();
        populate(instance, 10);
        instance.flush();

        sink.reset();
        instance.setCamera({ position: { x: 5000, y: 0 }, zoom: 1 });
        instance.flush();

        // The viewport moved, so every node's cull answer is genuinely in question.
        expect(sink.renderables).toBe(10);
    });

    it('reconsiders every node when a surface is hidden', () => {
        const { core: instance, sink } = core();
        populate(instance, 10);
        instance.flush();

        sink.reset();
        instance.setSurfaceVisible('world', false);
        instance.flush();

        expect(sink.renderables).toBe(10);
    });

    it('re-culls a node whose texture changed size', () => {
        const { core: instance, sink } = core();
        const id = instance.createNode({ kind: 'sprite', texture: 'block' });
        instance.flush();

        sink.reset();
        instance.updateNodes([{ id, texture: 'other' }]);
        instance.flush();

        // A different texture is a different extent, so the cull answer can change without any
        // transform write at all.
        expect(sink.renderables).toBe(1);
    });

    it('culls a child whose parent moved it out of view', () => {
        const { core: instance } = core();
        const parent = instance.createNode({ kind: 'group' });
        const child = instance.createNode({
            kind: 'sprite',
            texture: 'block',
            parent,
            position: { x: 0, y: 0 },
        });
        instance.flush();
        expect(instance.isCulled(child)).toBe(false);

        // Only the parent's local position was written, so the child reaches the cull pass through
        // its resolved position rather than through the flush-dirty set.
        instance.updateNodes([{ id: parent, position: { x: 100_000, y: 0 } }]);
        instance.flush();

        expect(instance.isCulled(child)).toBe(true);
    });
});
