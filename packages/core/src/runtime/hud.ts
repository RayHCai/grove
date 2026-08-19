import type { AssetRef } from './assets.js';
import type { BaseScript } from '../script/bases.js';
import type { Countdown } from './wrappers.js';
import type { Player } from './player.js';

export class HUDScreen {
    readonly name: string = '';
    readonly visible: boolean = false;

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

    // An inert screen rather than null: `hud.open('pause').close()` should no-op like every other
    // call here, and the declared return type is non-null.
    open(_screen: string): HUDScreen {
        return new HUDScreen();
    }
    close(_screen: string): void {}
    closeAll(): void {}

    screen(_name: string): HUDScreen | null {
        return null;
    }
    // Real arrays, not declarations: reading one off the inert `hud` should be an empty list rather
    // than a TypeError one line later.
    readonly screens: HUDScreen[] = [];
    readonly openScreens: HUDScreen[] = [];
}

export const hud: HUD = new HUD();
