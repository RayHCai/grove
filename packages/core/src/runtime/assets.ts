export type AssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

export class Asset {
    readonly key!: string;
    readonly kind!: AssetKind;
    readonly loaded!: boolean;
    readonly width!: number;
    readonly height!: number;
    readonly duration!: number;
}

export type AssetRef = Asset | string;

export interface Assets {
    get(key: string): Asset | null;
    all(kind?: AssetKind): Asset[];
}

export const assets: Assets = null!;
