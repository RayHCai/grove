// The four script bases. Location is the base class; host is a type parameter (§3.1).
// BaseScript is not extendable directly — it names no location.

import type { ScriptLocation } from './types.js';
import type { Player } from '../runtime/player.js';

export type Host = object;

export abstract class BaseScript<H extends Host = Host> {
    readonly host!: H;

    /** @internal — set by the engine during wiring. */
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
