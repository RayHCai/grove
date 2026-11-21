import type { RenderManifest, TemplateVisual, WireAssetRef } from '@platform/protocol';
import type { Codec } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { simError } from './errors.js';

/** Every visual declared so far, in declaration order, with the additions since the last drain. */
export class ManifestStore {
    readonly #assets = new Map<string, WireAssetRef>();
    readonly #templates = new Map<string, TemplateVisual>();
    readonly #codec: Codec;
    #pending: RenderManifest | null = null;

    constructor(initial: RenderManifest = { assets: [], templates: [] }, codec: Codec = jsonCodec) {
        this.#codec = codec;
        this.#admit(initial);
        // The boot manifest is not pending: nobody has joined yet, so no peer holds an older copy.
        for (const asset of initial.assets) this.#assets.set(asset.key, asset);
        for (const template of initial.templates) this.#templates.set(template.template, template);
    }

    /** Everything declared so far: the join payload. A copy, since the arrays cross a wire. */
    snapshot(): RenderManifest {
        return { assets: [...this.#assets.values()], templates: [...this.#templates.values()] };
    }

    /** Whether a template has been declared, so a caller can avoid re-announcing one. */
    hasTemplate(name: string): boolean {
        return this.#templates.has(name);
    }

    /** Declares more visuals, queueing whatever is genuinely new for the next send. */
    declare(manifest: RenderManifest): void {
        const assets = manifest.assets.filter((a) => !this.#assets.has(a.key));
        const templates = manifest.templates.filter((t) => !this.#templates.has(t.template));
        if (assets.length === 0 && templates.length === 0) return;
        this.#admit({ assets, templates });

        for (const asset of assets) this.#assets.set(asset.key, asset);
        for (const template of templates) this.#templates.set(template.template, template);

        const pending = (this.#pending ??= { assets: [], templates: [] });
        pending.assets.push(...assets);
        pending.templates.push(...templates);
    }

    // Refused here, before anything is kept: a stored entry the codec cannot encode fails the
    // `manifest` send to every peer and every `Welcome` after it, which carries the whole store.
    #admit(visuals: RenderManifest): void {
        try {
            this.#codec.encode({ kind: 'manifest', visuals });
        } catch (cause) {
            simError(
                'invalid-visuals',
                `a declared visual cannot cross the wire: ${cause instanceof Error ? cause.message : String(cause)}`,
                { cause },
            );
        }
    }

    /** The additions owed to already-connected peers, or `null`. Clears what it returns. */
    drain(): RenderManifest | null {
        const pending = this.#pending;
        this.#pending = null;
        return pending;
    }
}
