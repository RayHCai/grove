import type { AssetRef } from './assets.js';
import type { BaseScript } from '../script/bases.js';
import type { Countdown } from './wrappers.js';
import type { Player } from './player.js';

export class HUDScreen {
    readonly name!: string;
    readonly visible!: boolean;

    open(): void {}
    close(): void {}

    addScript(_script: new () => BaseScript<HUDScreen>): this {
        return this;
    }
}

export class HUD {
    readonly player!: Player;

    text(_widget: string, _value: string): void {}
    number(_widget: string, _value: number): void {}
    bar(_widget: string, _fraction: number): void {}
    icon(_widget: string, _asset: AssetRef): void {}
    timer(_widget: string, _countdown: Countdown): void {}
    show(_widget: string): void {}
    hide(_widget: string): void {}
    enable(_widget: string, _enabled?: boolean): void {}
    disable(_widget: string): void {}

    open(_screen: string): HUDScreen {
        return null!;
    }
    close(_screen: string): void {}
    closeAll(): void {}

    screen(_name: string): HUDScreen | null {
        return null;
    }
    readonly screens!: HUDScreen[];
    readonly openScreens!: HUDScreen[];
}

export const hud: HUD = null!;
