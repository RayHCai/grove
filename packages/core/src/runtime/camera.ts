// Camera is per-player and client-owned: presentation only, never authoritative (DESIGN
// §3.3). A ClientScript may write it — the one exception to "client code never writes". Its
// position/viewport are presentation values, not in the transform store and not captured by
// snapshot, so most of this is tier C until a client window exists.

import type { Bounds, Easing, Vec3 } from '@platform/math';
import { bounds as makeBounds, vec3 } from '@platform/math';
import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';

export class Camera {
    readonly #rt: Runtime;
    readonly player: Player;

    zoom = 1;
    bounds: Bounds | string | null = null;
    #x = 0;
    #y = 0;
    /** What the camera tracks; presentation-only, applied by the client (tier C). */
    followTarget: Player | Entity | null = null;

    constructor(rt: Runtime, player: Player) {
        this.#rt = rt;
        this.player = player;
    }

    get position(): Vec3 {
        return vec3(this.#x, this.#y, 0);
    }

    /** Client-window-dependent, so not readable from a SyncedScript (§3.3). Tier C. */
    get viewport(): Bounds {
        return makeBounds(this.#x - 400, this.#x + 400, this.#y + 300, this.#y - 300);
    }

    follow(target: Player | Entity | null): this {
        this.followTarget = target;
        return this;
    }

    moveTo(x: number, y: number): this {
        this.#x = x;
        this.#y = y;
        return this;
    }

    shake(_strength: number, _seconds: number): this {
        this.#rt.effects.play('camera.shake', { player: this.player.id });
        return this;
    }

    glideTo(x: number, y: number, _seconds: number, _easing?: Easing): Promise<void> {
        this.#x = x;
        this.#y = y;
        return Promise.resolve();
    }

    zoomTo(zoom: number, _seconds: number, _easing?: Easing): Promise<void> {
        this.zoom = zoom;
        return Promise.resolve();
    }

    addScript(script: new () => BaseScript<Camera>): this {
        this.#rt.wiring?.attachToCamera(this, script as never);
        return this;
    }
}
