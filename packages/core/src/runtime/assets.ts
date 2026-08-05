// Asset is immutable panel-loaded data (tier C — the panel loads it, DESIGN §3.5). The
// `assets` registry is read-only; loading stays in the panel. Core holds whatever the
// manifest declares, and answers null for an unknown key rather than throwing.

export type AssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

export class Asset {
    readonly key: string;
    readonly kind: AssetKind;
    readonly loaded: boolean;
    readonly width: number;
    readonly height: number;
    readonly duration: number;

    constructor(key: string, kind: AssetKind, meta?: { width?: number; height?: number; duration?: number }) {
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

/** The panel-loaded asset table. loadGame populates it from the manifest; empty otherwise. */
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
        return kind ? all.filter(a => a.kind === kind) : all;
    }
}

const emptyRegistry = new AssetRegistry();

/** The creator-facing `assets` const — a facade over the current runtime's registry. */
export const assets: Assets = {
    get: key => resolve().get(key),
    all: kind => resolve().all(kind),
};

let currentRegistry: () => Assets = () => emptyRegistry;

/** @internal — loadGame installs the live registry accessor. */
export function setAssetRegistry(fn: () => Assets): void {
    currentRegistry = fn;
}

function resolve(): Assets {
    return currentRegistry();
}
