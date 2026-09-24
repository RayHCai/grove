// Turning what a compile emitted into classes a world can attach.
//
// The modules are evaluated for real — `data:` urls rather than the browser's `blob:` ones, because
// that is what node's loader can fetch — so what is asserted is a live class, not a plan to make
// one. The engine handed in is a stand-in: this file is about the wiring, and the real engine is
// what the editor passes in its place.

import { describe, expect, it } from 'vitest';
import { PROJECT_FORMAT_VERSION, scriptId } from '@platform/project';
import type { ProjectManifest, ScriptModule } from '@platform/project';
import type { LocalVersion } from '../src/project/compile';
import { LinkError, linkVersion } from '../src/project/link';
import type { ConsoleSink } from '../src/project/link';

/** node reads these; a browser reads the `blob:` urls the editor makes instead. */
function dataUrl(text: string): string {
    return `data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}

function load(url: string): Promise<Record<string, unknown>> {
    return import(url) as Promise<Record<string, unknown>>;
}

/** Stands in for a script base; the field is what stops it being an empty class. */
class Base {
    readonly host: unknown = null;
}

/** Only what a linked module actually reads off it; the real one is `@platform/engine`. */
function engine(): Record<string, unknown> {
    return { ServerScript: Base, ClientScript: Base, SyncedScript: Base, clamp: (n: number) => n };
}

function sink(lines: string[] = []): ConsoleSink & { lines: string[] } {
    const push =
        (level: string) =>
        (...values: unknown[]): void => {
            lines.push(`${level}:${values.map(String).join(' ')}`);
        };
    return {
        lines,
        log: push('log'),
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
    };
}

function project(scriptModules: ScriptModule[]): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'a-game',
        contentHash: 'a-hash',
        settings: {
            simRate: 30,
            sendRate: 15,
            maxPlayers: 4,
            bounds: { left: -480, right: 480, top: 270, bottom: -270 },
            regions: [],
        },
        assets: [],
        scriptModules,
        templates: [],
        entities: [],
        gameScripts: [],
    };
}

function version(modules: Record<string, string>, scriptModules: ScriptModule[]): LocalVersion {
    return { project: project(scriptModules), modules, needsEngine: true };
}

function link(built: LocalVersion, console: ConsoleSink = sink()): ReturnType<typeof linkVersion> {
    return linkVersion(built, { engine: engine(), console, urlFor: dataUrl, load });
}

const RULES: ScriptModule = {
    path: 'src/player.ts',
    scripts: [
        { id: scriptId('src/player#Rules'), export: 'Rules', location: 'server', host: 'game' },
    ],
};

describe('linking a compiled game into this page', () => {
    it('answers with the class the manifest named, under the id it named it by', async () => {
        const built = version(
            {
                'src/player.js':
                    "import { ServerScript } from '@platform/engine';\n" +
                    'export class Rules extends ServerScript {}\n',
            },
            [RULES],
        );

        const linked = await link(built);
        try {
            expect(linked.scripts).toHaveLength(1);
            const entry = linked.scripts[0];
            expect(entry?.id).toBe('src/player#Rules');
            expect(entry?.location).toBe('server');
            // The engine this page holds, not a second copy: a world checks a class against the
            // base it knows, and two engines would be two bases of which it recognises one.
            expect(Object.getPrototypeOf(entry?.ctor)).toBe(Base);
        } finally {
            linked.dispose();
        }
    });

    it('resolves a creator’s own import to the module beside it', async () => {
        const built = version(
            {
                'src/shared.js': 'export const SPEED = 180;\n',
                'src/player.js':
                    "import { ServerScript } from '@platform/engine';\n" +
                    "import { SPEED } from './shared';\n" +
                    'export class Rules extends ServerScript { speed = SPEED; }\n',
            },
            [RULES],
        );

        const linked = await link(built);
        try {
            const Rules = linked.scripts[0]?.ctor as unknown as new () => { speed: number };
            expect(new Rules().speed).toBe(180);
        } finally {
            linked.dispose();
        }
    });

    it('sends what a run logs to the editor rather than to the page', async () => {
        const console = sink();
        const built = version(
            {
                'src/player.js':
                    "import { ServerScript } from '@platform/engine';\n" +
                    "console.log('hello', 2);\n" +
                    'export class Rules extends ServerScript {}\n',
            },
            [RULES],
        );

        const linked = await link(built, console);
        try {
            expect(console.lines).toEqual(['log:hello 2']);
        } finally {
            linked.dispose();
        }
    });

    it('leaves a file that declares its own console alone', async () => {
        const console = sink();
        const built = version(
            {
                'src/player.js':
                    "import { ServerScript } from '@platform/engine';\n" +
                    'const console = { log: () => undefined };\n' +
                    "console.log('quiet');\n" +
                    'export class Rules extends ServerScript {}\n',
            },
            [RULES],
        );

        const linked = await link(built, console);
        try {
            // Injecting a binding over one the file declares is a module that will not load at
            // all, which is a worse answer than letting the creator have their own name.
            expect(console.lines).toEqual([]);
        } finally {
            linked.dispose();
        }
    });

    it('refuses a graph that imports itself around a circle', async () => {
        const built = version(
            {
                'src/a.js': "import './b';\nexport const a = 1;\n",
                'src/b.js': "import './a';\nexport const b = 2;\n",
            },
            [],
        );

        await expect(link(built)).rejects.toThrow(LinkError);
    });

    it('names the module when a manifest claims an export the code does not have', async () => {
        const built = version({ 'src/player.js': 'export const nothing = 1;\n' }, [RULES]);
        await expect(link(built)).rejects.toThrow(/src\/player\.ts does not export .*Rules/u);
    });

    it('names the module when the compiler emitted nothing for it', async () => {
        await expect(link(version({}, [RULES]))).rejects.toThrow(/emitted no src\/player\.js/u);
    });

    it('leaves nothing of a finished link standing on the global', async () => {
        const before = Object.keys(globalThis).filter((key) => key.startsWith('grove:'));
        const linked = await link(version({ 'src/player.js': 'export class Rules {}\n' }, [RULES]));
        linked.dispose();
        expect(Object.keys(globalThis).filter((key) => key.startsWith('grove:'))).toEqual(before);
    });
});
