// Residency bookkeeping and the GPU-side release, with no GPU: `Texture` and `BufferImageSource`
// are plain objects until something draws them, and `Assets` is spied on rather than driven, so the
// only thing not exercised here is the network fetch itself.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Assets, BufferImageSource, Texture } from 'pixi.js';
import { AssetRegistry } from '../src/pixi/asset-registry.js';
import type { AssetManifestEntry } from '../src/renderer.js';

function texture(label = 'test'): Texture {
    return new Texture({
        source: new BufferImageSource({
            resource: new Uint8Array([1, 2, 3, 4]),
            width: 1,
            height: 1,
            label,
        }),
        label,
    });
}

const textEntry: AssetManifestEntry = { name: 'label', kind: 'text', text: 'hi' };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('AssetRegistry', () => {
    it('reports a magenta placeholder for an unresolved name', () => {
        const registry = new AssetRegistry();

        // White would draw as a pale speck: a missing texture has to read as a failure.
        expect(registry.get('nope')).toBe(registry.placeholder);
        expect(registry.placeholder.source.label).toBe('renderer:placeholder');
    });

    it('destroys a rasterized text texture on unload', () => {
        const registry = new AssetRegistry();
        const raster = texture('label');
        registry.registerTexture(textEntry, raster, { width: 10, height: 4 });

        expect(registry.unload('label')).toBe(true);

        // The raster is a render target this registry built, so dropping the map entry alone leaks
        // it: nothing else holds a reference to destroy.
        expect(raster.destroyed).toBe(true);
        expect(registry.has('label')).toBe(false);
    });

    it('destroys the texture a re-registration replaces', () => {
        const registry = new AssetRegistry();
        const first = texture('first');
        const second = texture('second');

        registry.registerTexture(textEntry, first, { width: 1, height: 1 });
        registry.registerTexture(textEntry, second, { width: 2, height: 2 });

        expect(first.destroyed).toBe(true);
        expect(second.destroyed).toBe(false);
    });

    it('destroys owned textures on clear', () => {
        const registry = new AssetRegistry();
        const raster = texture();
        registry.registerTexture(textEntry, raster, { width: 1, height: 1 });

        registry.clear();

        expect(raster.destroyed).toBe(true);
    });

    it('never destroys the shared placeholder', () => {
        const registry = new AssetRegistry();
        registry.registerTexture(
            { name: 'font', kind: 'font', url: '/f.woff2' },
            registry.placeholder,
            { width: 0, height: 0 },
        );

        registry.unload('font');
        registry.clear();

        expect(registry.placeholder.destroyed).toBe(false);
    });

    it('unloads through Assets with the url it was loaded by, not the logical name', async () => {
        const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined);
        const registry = new AssetRegistry();
        registry.registerTexture({ name: 'tiles', kind: 'atlas', url: '/tiles.json' }, texture(), {
            width: 1,
            height: 1,
        });

        registry.unload('tiles');

        // Handing the resolver our logical name makes it invent an entry, warn, and release nothing.
        expect(unload).toHaveBeenCalledWith('/tiles.json');
    });

    it('does not ask Assets to unload a rasterized entry it never loaded', () => {
        const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined);
        const registry = new AssetRegistry();
        registry.registerTexture(textEntry, texture(), { width: 1, height: 1 });

        registry.unload('label');

        expect(unload).not.toHaveBeenCalled();
    });

    it('reports no frames for a name that is not an atlas', () => {
        const registry = new AssetRegistry();
        registry.registerTexture(textEntry, texture(), { width: 1, height: 1 });

        expect(registry.framesOf('label')).toEqual([]);
        expect(registry.framesOf('missing')).toEqual([]);
    });
});
