// Location is the base class and host a type parameter; BaseScript names no location, so
// nothing attachable extends it directly.

import type { ScriptLocation } from './types.js';
import type { Player } from '../runtime/player.js';

export type Host = object;

export abstract class BaseScript<H extends Host = Host> {
    readonly host!: H;

    /** @internal — declared by the location subclasses, read at wire time. */
    static readonly __location: ScriptLocation = undefined!;
}

export abstract class ServerScript<H extends Host = Host> extends BaseScript<H> {
    static override readonly __location: ScriptLocation = 'server';
}

export abstract class ClientScript<H extends Host = Host> extends BaseScript<H> {
    readonly localPlayer!: Player;
    static override readonly __location: ScriptLocation = 'client';
}

export abstract class SyncedScript<H extends Host = Host> extends BaseScript<H> {
    static override readonly __location: ScriptLocation = 'synced';
}
