import type { AssetRef } from './assets.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Vec3 } from '@platform/math';

export interface SoundHandle {
    stop(): void;
    volume: number;
}

export interface SoundOptions {
    at?: Entity | Vec3;
    for?: Player;
    volume?: number;
    loop?: boolean;
}

export interface Sound {
    play(asset: AssetRef, opts?: SoundOptions): SoundHandle;
    stopAll(): void;
    volume: number;
}

export interface Music {
    play(asset: AssetRef, opts?: { loop?: boolean; fade?: number }): SoundHandle;
    stop(fade?: number): void;
    volume: number;
}

export const sound: Sound = null!;
export const music: Music = null!;
