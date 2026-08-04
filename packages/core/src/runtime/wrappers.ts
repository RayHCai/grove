import type { Player } from './player.js';

export abstract class StatefulWrapper {
    bind(_record: object, _fieldName: string): void {}
    serialize(): unknown { return null; }
    restore(_data: unknown): void {}
}

export class Countdown {
    readonly remaining!: number;

    constructor(seconds: number, onZero?: () => void) {
        void seconds;
        void onZero;
    }
    start(): void {}
    pause(): void {}
    reset(_seconds?: number): void {}
}

export class Storage {
    constructor(player?: Player) {
        void player;
    }
    get(_key: string): Promise<unknown> { return Promise.resolve(undefined); }
    set(_key: string, _value: unknown): Promise<void> { return Promise.resolve(); }
    delete(_key: string): Promise<void> { return Promise.resolve(); }
}

export class Scoreboard extends StatefulWrapper {
    add(_amount: number, _player?: Player): void {}
    set(_amount: number, _player?: Player): void {}
    of(_player: Player): number { return 0; }
    top(_n: number): Player[] { return []; }
    reset(): void {}
}

export class Leaderboard extends StatefulWrapper {
    constructor(_opts?: { order?: 'high' | 'low'; persist?: boolean }) { super(); }
    submit(_score: number, _player?: Player): void {}
    of(_player: Player): number { return 0; }
    top(_n: number): Array<{ player: Player; score: number }> { return []; }
    rankOf(_player: Player): number { return 0; }
}

export class Inventory extends StatefulWrapper {
    constructor(_player: Player) { super(); }
    add(_item: string, _count?: number): void {}
    remove(_item: string, _count?: number): void {}
    has(_item: string): boolean { return false; }
    count(_item: string): number { return 0; }
    clear(): void {}
}

export class Team extends StatefulWrapper {
    readonly name!: string;
    readonly players!: Player[];

    constructor(_name: string) { super(); }
    add(_player: Player): void {}
    remove(_player: Player): void {}
    has(_player: Player): boolean { return false; }
}
