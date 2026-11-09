// Turning a compile into the classes a world attaches, in the run's document. Node resolves the map
// by inlining each target as a `data:` url, which a cycle cannot be, so for one the map is asserted.

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { PROJECT_FORMAT_VERSION, scriptId } from '@platform/project';
import type { ProjectManifest, ScriptModule } from '@platform/project';
import { HOST_MODULE, LinkError, entriesOf, link } from '../src/preview/link';
import type { ConsoleSink, LinkHost } from '../src/preview/link';

/** Stands in for a script base; the field is what stops it being an empty class. */
class Base {
    readonly host: unknown = null;
}

function engine(): Record<string, unknown> {
    return { ServerScript: Base, ClientScript: Base, SyncedScript: Base };
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

/** A linker whose map is kept, with node's loader standing in for the browser's. */
function linked(
    modules: Record<string, string>,
    host: LinkHost = { engine: engine(), console: sink() },
) {
    const texts = new Map<string, string>();
    let imports: Readonly<Record<string, string>> = {};
    const urlFor = (text: string): string => {
        const id = `text:${String(texts.size)}`;
        texts.set(id, text);
        return id;
    };
    const inline = (specifier: string): string => {
        const text = texts.get(imports[specifier] ?? '') ?? '';
        const resolved = text.replaceAll(
            /(['"])([^'"\n]+)\1/gu,
            (whole, quote: string, named: string) =>
                named in imports ? `${quote}${inline(named)}${quote}` : whole,
        );
        return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
    };
    const linker = link(modules, {
        host,
        urlFor,
        install: (map) => {
            imports = map;
        },
        load: async (specifier) =>
            import(/* @vite-ignore */ inline(specifier)) as Promise<Record<string, unknown>>,
    });
    return {
        linker,
        imports: () => imports,
        text: (specifier: string) => texts.get(imports[specifier] ?? ''),
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

const RULES: ScriptModule = {
    path: 'src/player.ts',
    scripts: [
        { id: scriptId('src/player#Rules'), export: 'Rules', location: 'server', host: 'game' },
    ],
};

describe('a compile, linked in the run’s document', () => {
    it('answers with the class the manifest named, extending the engine it was handed', async () => {
        const { linker } = linked({
            'src/player.js':
                "import { ServerScript } from '@platform/engine';\n" +
                'export class Rules extends ServerScript {}\n',
        });

        const [entry] = await entriesOf(project([RULES]), linker);
        expect(entry?.id).toBe('src/player#Rules');
        expect(entry?.location).toBe('server');
        // The engine the document holds, not a second copy: a world checks a class against the
        // base it knows, and two engines would be two bases of which it recognises one.
        expect(Object.getPrototypeOf(entry?.ctor)).toBe(Base);
    });

    it('resolves a creator’s own import to the module beside it', async () => {
        const { linker } = linked({
            'src/shared.js': 'export const SPEED = 180;\n',
            'src/player.js':
                "import { ServerScript } from '@platform/engine';\n" +
                "import { SPEED } from './shared';\n" +
                'export class Rules extends ServerScript { speed = SPEED; }\n',
        });

        const [entry] = await entriesOf(project([RULES]), linker);
        const Rules = entry?.ctor as unknown as new () => { speed: number };
        expect(new Rules().speed).toBe(180);
    });

    it('names both halves of a cycle for the loader, which links one the way a bundle does', () => {
        const { imports, text } = linked({
            'src/a.js': "import { b } from './b';\nexport const a = () => b;\n",
            'src/b.js': "import { a } from './a.js';\nexport const b = () => a;\n",
        });

        // Nothing is refused for the circle: each module names the other by the map's name, so
        // neither url has to exist before the other is made.
        expect(Object.keys(imports())).toEqual(
            expect.arrayContaining(['grove:src/a.js', 'grove:src/b.js']),
        );
        expect(text('grove:src/a.js')).toContain("from 'grove:src/b.js'");
        expect(text('grove:src/b.js')).toContain("from 'grove:src/a.js'");
    });

    it('says which import names nothing in this game, before anything is evaluated', () => {
        expect(() => linked({ 'src/a.js': "import './gone';\n" })).toThrow(
            new LinkError('src/a.js imports ./gone, and nothing in this game is there'),
        );
    });

    it('sends what a run logs to the console it was handed', async () => {
        const console = sink();
        const { linker } = linked({ 'src/main.js': "console.log('hello', 2);\n" }, { console });

        await linker.load('src/main.js');
        expect(console.lines).toEqual(['log:hello 2']);
    });

    it('leaves a file that declares its own console alone', async () => {
        const console = sink();
        const { linker } = linked(
            {
                'src/main.js': "const console = { log: () => undefined };\nconsole.log('quiet');\n",
            },
            { console },
        );

        // Injecting a binding over one the file declares is a module that will not load at all.
        await linker.load('src/main.js');
        expect(console.lines).toEqual([]);
    });

    it('maps the engine’s own name for a world alone, and the console for any run', () => {
        expect(Object.keys(linked({}, { console: sink() }).imports())).toEqual([HOST_MODULE]);
        expect(Object.keys(linked({}).imports())).toEqual([HOST_MODULE, '@platform/engine']);
    });

    it('names the module when a manifest claims an export the code does not have', async () => {
        const { linker } = linked({ 'src/player.js': 'export const nothing = 1;\n' });
        await expect(entriesOf(project([RULES]), linker)).rejects.toThrow(
            /src\/player\.ts does not export a class called Rules/u,
        );
    });

    it('names the module when the compiler emitted nothing for it', async () => {
        await expect(entriesOf(project([RULES]), linked({}).linker)).rejects.toThrow(
            /emitted no src\/player\.js/u,
        );
    });
});
