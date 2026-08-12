// Camera state is presentation-only: it is held here rather than in the transform store, so no
// snapshot captures it and no replication mark follows a write.

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
    /** Stored for the client to apply; nothing in core reads it. */
    followTarget: Player | Entity | null = null;

    constructor(rt: Runtime, player: Player) {
        this.#rt = rt;
        this.player = player;
    }

    get position(): Vec3 {
        return vec3(this.#x, this.#y, 0);
    }

    /** Placeholder extents — the real ones depend on a client window core cannot see. */
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
