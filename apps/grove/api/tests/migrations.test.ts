// The committed migrations and the Prisma schema have to describe one database, or `migrate dev`
// writes the difference into the next migration someone generates.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { database, type Database } from './pglite.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

let harness: Database;

beforeAll(async () => {
    harness = await database();
}, 60_000);

afterAll(async () => {
    await harness?.close();
});

/** Asynchronous, because the database it diffs against answers from this same process. */
function diff(url: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                'node_modules/prisma/build/index.js',
                'migrate',
                'diff',
                '--from-config-datasource',
                '--to-schema',
                'prisma/schema.prisma',
                '--script',
                '--exit-code',
            ],
            { cwd: PACKAGE, env: { ...process.env, DATABASE_URL: url }, windowsHide: true },
        );
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, output }));
    });
}

describe('the migrations', () => {
    // Exit 2 is a difference, and its script is what the next generated migration would carry.
    it('build exactly the database the schema describes', async () => {
        const { code, output } = await diff(`${harness.url}?sslmode=disable`);
        expect(output).not.toMatch(/\b(CREATE|ALTER|DROP)\b/u);
        expect(code).toBe(0);
    }, 120_000);
});
