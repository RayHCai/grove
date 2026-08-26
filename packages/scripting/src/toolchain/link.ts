// Stage two: one ESM chunk per side, linked from the LOWERED output and never from source.
//
// Determinism is the point, so nothing here may vary with the machine: the entry module is
// generated in id order, rolldown runs with its cwd at the lowered root so a module comment
// carries a relative path rather than someone's home directory, and the emitted text is folded to
// LF and POSIX separators before it is hashed.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';
import type { ScriptLocation } from '@platform/core';
import { BundleError } from '../errors.js';
import type { ScriptSide } from '../registry.js';
import { locationsFor } from '../registry.js';

/** One class, as the bundle stamps it into the chunk. */
export interface ScriptDeclaration<Id extends string = string> {
    readonly id: Id;
    /** POSIX, relative to the source root, without an extension. */
    readonly module: string;
    /** The name the module exports it under; `default` for a default export. */
    readonly export: string;
    readonly location: ScriptLocation;
}

export interface SideChunk<Id extends string = string> {
    readonly side: ScriptSide;
    /** `<side>-<first 16 of hash>.js`. */
    readonly fileName: string;
    readonly code: string;
    /** SHA-256 of the normalised code, hex. */
    readonly hash: string;
    /** Bare specifiers the chunk still imports — what the evaluation boundary has to resolve. */
    readonly imports: readonly string[];
    readonly scripts: readonly Id[];
}

export interface ScriptBundle<Id extends string = string> {
    readonly client: SideChunk<Id>;
    readonly server: SideChunk<Id>;
    /**
     * SHA-256 of the synced classes linked on their own.
     *
     * A handshake compares this, not either chunk's `hash`: the two sides carry different classes
     * by construction, so their hashes always differ, while prediction is unsound exactly when the
     * two ends run different `SyncedScript` bytes.
     */
    readonly syncedHash: string;
    /** Every declaration that reached a chunk, in id order. */
    readonly scripts: readonly ScriptDeclaration<Id>[];
}

export interface LinkOptions<Id extends string = string> {
    /** `lowerScripts`' output directory. */
    readonly loweredDir: string;
    /** Where the two side chunks are written. */
    readonly outDir: string;
    readonly scripts: readonly ScriptDeclaration<Id>[];
}

type LinkTarget = ScriptSide | 'synced';

export async function linkChunks<Id extends string = string>(
    options: LinkOptions<Id>,
): Promise<ScriptBundle<Id>> {
    const loweredDir = path.resolve(options.loweredDir);
    const outDir = path.resolve(options.outDir);
    const scripts = options.scripts.toSorted((a, b) => a.id.localeCompare(b.id));

    for (const declaration of scripts) {
        const emitted = path.join(loweredDir, `${declaration.module}.js`);
        if (!existsSync(emitted)) {
            throw new BundleError(
                `${declaration.module}.js is not in the lowered output — the analysed source root must be the tsconfig's rootDir`,
            );
        }
    }

    mkdirSync(outDir, { recursive: true });
    const server = sideChunk('server', await link('server', loweredDir, scripts));
    const client = sideChunk('client', await link('client', loweredDir, scripts));
    // Linked and hashed, never written: this half exists so the two real sides can be compared.
    const synced = await link('synced', loweredDir, scripts);

    writeFileSync(path.join(outDir, server.fileName), server.code, 'utf8');
    writeFileSync(path.join(outDir, client.fileName), client.code, 'utf8');

    return { client, server, syncedHash: synced.hash, scripts };
}

interface LinkedChunk<Id extends string> {
    readonly code: string;
    readonly hash: string;
    readonly imports: readonly string[];
    readonly scripts: readonly Id[];
}

function sideChunk<Id extends string>(side: ScriptSide, linked: LinkedChunk<Id>): SideChunk<Id> {
    return { side, fileName: `${side}-${linked.hash.slice(0, 16)}.js`, ...linked };
}

async function link<Id extends string>(
    target: LinkTarget,
    loweredDir: string,
    all: readonly ScriptDeclaration<Id>[],
): Promise<LinkedChunk<Id>> {
    const locations = target === 'synced' ? SYNCED_ONLY : locationsFor(target as ScriptSide);
    const scripts = all.filter((s) => locations.has(s.location));

    const entryPath = path.join(loweredDir, `.script-entry-${target}.js`);
    writeFileSync(entryPath, entrySource(target, scripts), 'utf8');

    const build = await rolldown({
        cwd: loweredDir,
        input: { chunk: entryPath },
        external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
        platform: 'neutral',
        logLevel: 'silent',
    });
    let output;
    try {
        ({ output } = await build.generate({ format: 'esm', sourcemap: false, minify: false }));
    } finally {
        await build.close();
    }

    const chunks = output.filter((piece) => piece.type === 'chunk');
    const chunk = chunks[0];
    if (!chunk || chunks.length !== 1) {
        throw new BundleError(
            `the ${target} half linked into ${chunks.length} chunks — a script module may not import dynamically`,
        );
    }

    const code = normalizeCode(chunk.code);
    return {
        code,
        hash: sha256(code),
        imports: chunk.imports.toSorted(),
        scripts: scripts.map((s) => s.id),
    };
}

const SYNCED_ONLY: ReadonlySet<ScriptLocation> = new Set(['synced']);

function entrySource(target: LinkTarget, scripts: readonly ScriptDeclaration[]): string {
    const lines: string[] = [];
    scripts.forEach((script, index) => {
        const specifier = JSON.stringify(`./${script.module}.js`);
        lines.push(
            script.export === 'default'
                ? `import s${index} from ${specifier};`
                : `import { ${script.export} as s${index} } from ${specifier};`,
        );
    });
    lines.push('');
    lines.push(`export const side = ${JSON.stringify(target)};`);
    lines.push('export const scripts = [');
    scripts.forEach((script, index) => {
        lines.push(
            `\t{ id: ${JSON.stringify(script.id)}, location: ${JSON.stringify(script.location)}, ctor: s${index} },`,
        );
    });
    lines.push('];');
    return `${lines.join('\n')}\n`;
}

function normalizeCode(code: string): string {
    const lf = code.replace(/\r\n?/g, '\n');
    const posix = lf.replace(/^\/\/#(?:region|endregion).*$/gm, (line) => line.replace(/\\/g, '/'));
    return `${posix.replace(/\s+$/, '')}\n`;
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
