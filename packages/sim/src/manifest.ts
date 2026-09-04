import type { RenderManifest, TemplateVisual, WireAssetRef } from '@platform/protocol';

/** Every visual declared so far, in declaration order, with the additions since the last drain. */
export class ManifestStore {
    readonly #assets = new Map<string, WireAssetRef>();
    readonly #templates = new Map<string, TemplateVisual>();
    #pending: RenderManifest | null = null;

    constructor(initial: RenderManifest = { assets: [], templates: [] }) {
        // The boot manifest is not pending: nobody has joined yet, so no peer holds an older copy.
        for (const asset of initial.assets) this.#assets.set(asset.key, asset);
        for (const template of initial.templates) this.#templates.set(template.template, template);
    }

    /** Everything declared so far — the join payload. A copy, since the arrays cross a wire. */
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

        for (const asset of assets) this.#assets.set(asset.key, asset);
        for (const template of templates) this.#templates.set(template.template, template);

        const pending = (this.#pending ??= { assets: [], templates: [] });
        pending.assets.push(...assets);
        pending.templates.push(...templates);
    }

    /** The additions owed to already-connected peers, or `null`. Clears what it returns. */
    drain(): RenderManifest | null {
        const pending = this.#pending;
        this.#pending = null;
        return pending;
    }
}
