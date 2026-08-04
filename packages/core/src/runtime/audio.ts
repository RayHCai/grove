// Audio (tier C — needs the audio layer, DESIGN §2). The facades route to the runtime's
// EffectSink, whose null implementation drops calls (and drops them under replay, §8.1).
// A real SoundHandle arrives when the audio layer fills the seam.

import type { AssetRef } from './assets.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Vec3 } from '@platform/math';
import { currentRuntime, hasRuntime } from './runtime.js';

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

const nullHandle: SoundHandle = { stop() {}, volume: 1 };

function emit(kind: string, asset: AssetRef, opts?: unknown): SoundHandle {
    if (hasRuntime()) currentRuntime().effects.play(kind, { asset, opts });
    return nullHandle;
}

export const sound: Sound = {
    play: (asset, opts) => emit('sound.play', asset, opts),
    stopAll: () => {
        if (hasRuntime()) currentRuntime().effects.play('sound.stopAll');
    },
    volume: 1,
};

export const music: Music = {
    play: (asset, opts) => emit('music.play', asset, opts),
    stop: fade => {
        if (hasRuntime()) currentRuntime().effects.play('music.stop', { fade });
    },
    volume: 1,
};
