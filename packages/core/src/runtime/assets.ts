// Core never loads an asset: it holds whatever the manifest declared, so there is no load API here.

import { currentRuntime, hasRuntime } from './runtime.js';

export type AssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

export class Asset {
    readonly key: string;
    readonly kind: AssetKind;
    readonly loaded: boolean;
    readonly width: number;
    readonly height: number;
    readonly duration: number;

    constructor(
        key: string,
        kind: AssetKind,
        meta?: { width?: number; height?: number; duration?: number },
    ) {
        this.key = key;
        this.kind = kind;
        this.loaded = true;
        this.width = meta?.width ?? 0;
        this.height = meta?.height ?? 0;
        this.duration = meta?.duration ?? 0;
    }
}

export type AssetRef = Asset | string;

export interface Assets {
    get(key: string): Asset | null;
    all(kind?: AssetKind): Asset[];
}

/** The asset table loadGame fills from the manifest; empty otherwise. */
export class AssetRegistry implements Assets {
    readonly #byKey = new Map<string, Asset>();

    define(asset: Asset): void {
        this.#byKey.set(asset.key, asset);
    }

    get(key: string): Asset | null {
        return this.#byKey.get(key) ?? null;
    }

    all(kind?: AssetKind): Asset[] {
        const all = [...this.#byKey.values()];
        return kind ? all.filter((a) => a.kind === kind) : all;
    }
}

const emptyRegistry = new AssetRegistry();

/** The creator-facing `assets` const — a facade over the current runtime's registry. */
export const assets: Assets = {
    get: (key) => resolve().get(key),
    all: (kind) => resolve().all(kind),
};

// Resolved per call off the runtime, not held in a module slot: a second loadGame would otherwise
// repoint the first world's assets, and withRuntime could not put them back.
function resolve(): Assets {
    return hasRuntime() ? (currentRuntime().wiredOrNull?.assets ?? emptyRegistry) : emptyRegistry;
}
