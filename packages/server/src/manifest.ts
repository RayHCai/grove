// The live render manifest: what every joiner is handed, and what already-connected peers are owed
// when it grows.
//
// A value captured at construction cannot answer both. A template first used at tick 5000 is in no
// earlier joiner's copy, so its entities draw as the placeholder for the rest of that session while
// a client joining a second later sees them correctly — the same world rendering two ways depending
// on when a tab was opened.

import type { RenderManifest, TemplateVisual, WireAssetRef } from '@platform/protocol';

/**
 * Every visual declared so far, in declaration order, with the additions since the last drain.
 *
 * Keyed by name on both halves, so re-declaring a template is a no-op rather than a second entry the
 * client would merge over itself. Order is kept because the join payload is read top to bottom and a
 * reader comparing it to the panel's own list should find them in the same sequence.
 */
export class ManifestStore {
    readonly #assets = new Map<string, WireAssetRef>();
    readonly #templates = new Map<string, TemplateVisual>();
    #pending: RenderManifest | null = null;

    constructor(initial: RenderManifest = { assets: [], templates: [] }) {
        // The boot manifest is not pending: nobody has joined yet, so there is no peer holding an
        // older copy, and every joiner reads the whole thing out of `snapshot()`.
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

    /**
     * Declares more visuals, queueing whatever is genuinely new for the next send.
     *
     * Re-declaring an identical entry adds nothing to the queue: the common call is a template
     * coming into use for the second time, and a peer that already drew one of it needs no envelope.
     */
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
