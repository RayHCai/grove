// What the manifest restates about the code: which classes are scripts, where each runs, and what
// it attaches to. The base class in the source is the declaration; this reads it back.

import { describe, expect, it } from 'vitest';
import { scanScripts } from '../src/project/scripts';

function scan(text: string, path = 'src/player.ts'): ReturnType<typeof scanScripts> {
    return scanScripts([{ path, text }]);
}

describe('reading the scripts out of a project', () => {
    it('takes the location from the base class and the host from its type argument', () => {
        const found = scan(
            'export class Rules extends ServerScript<Game> {}\n' +
                'export class Eyes extends ClientScript<Player> {}\n' +
                'export class Body extends SyncedScript<Entity> {}\n',
        );
        expect(found.modules).toEqual([
            {
                path: 'src/player.ts',
                scripts: [
                    { id: 'src/player#Rules', export: 'Rules', location: 'server', host: 'game' },
                    { id: 'src/player#Eyes', export: 'Eyes', location: 'client', host: 'player' },
                    { id: 'src/player#Body', export: 'Body', location: 'synced', host: 'entity' },
                ],
            },
        ]);
    });

    it('knows a movement is an entity-hosted synced script without being told', () => {
        const found = scan('export class Walk extends TopDownMovement {}\n');
        expect(found.modules[0]?.scripts[0]).toEqual({
            id: 'src/player#Walk',
            export: 'Walk',
            location: 'synced',
            host: 'entity',
        });
        expect(found.faults).toEqual([]);
    });

    it('follows the project’s own classes to the engine base under them', () => {
        const found = scan(
            'export class Walk extends TopDownMovement {}\n' +
                'export class Sprint extends Walk {}\n',
        );
        expect(found.modules[0]?.scripts[1]).toMatchObject({
            export: 'Sprint',
            location: 'synced',
            host: 'entity',
        });
    });

    it('passes over a class that is not a script at all', () => {
        const found = scan('export class Tally extends Map<string, number> {}\n');
        expect(found.modules).toEqual([]);
        expect(found.faults).toEqual([]);
    });

    it('passes over a class nobody exports, which no attachment could name', () => {
        expect(scan('class Hidden extends ServerScript<Game> {}\n').modules).toEqual([]);
    });

    it('faults a script that names no host, because an attachment is checked against one', () => {
        const found = scan('export class Rules extends ServerScript {}\n');
        expect(found.modules).toEqual([]);
        expect(found.faults[0]).toEqual({
            path: 'src/player.ts',
            name: 'Rules',
            message: 'ServerScript needs the host it attaches to, as ServerScript<Entity>',
        });
    });

    it('faults a host that is not something a script attaches to', () => {
        expect(
            scan('export class Rules extends ServerScript<Sprout> {}\n').faults[0]?.message,
        ).toBe('Sprout is not something a script attaches to');
    });

    it('keeps one entry per module, in path order', () => {
        const found = scanScripts([
            { path: 'src/zebra.ts', text: 'export class Z extends ServerScript<Game> {}' },
            { path: 'src/apple.ts', text: 'export class A extends ServerScript<Game> {}' },
            { path: 'art/tile.png', text: 'export class Nope extends ServerScript<Game> {}' },
        ]);
        expect(found.modules.map((module) => module.path)).toEqual([
            'src/apple.ts',
            'src/zebra.ts',
        ]);
    });
});
