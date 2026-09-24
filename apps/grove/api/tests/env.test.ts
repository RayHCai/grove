// `.env.example` is what a contributor copies to `.env` and what a reader takes the variable list
// from, and nothing else reads it — so it drifts silently, and the way it surfaces is a process that
// will not start hours after the change that broke it. Parsed here against the one schema, so a
// variable added to `src/env.ts` without a line here fails the suite instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));

/** The `KEY="value"` lines, which is all the file is; comments and blanks are not variables. */
function parseDotenv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const [, name, value] = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line) ?? [];
        if (name !== undefined && value !== undefined)
            out[name] = value.replace(/^["'](.*)["']$/u, '$1');
    }
    return out;
}

// Named rather than derived from the schema: a schema edit that dropped one of these would
// otherwise take this test with it, and each is something the service cannot answer without.
const REQUIRED = [
    'NODE_ENV',
    'GAMES_CDN_URL',
    'SESSION_SECRET',
    'GAME_TOKEN_SECRET',
    'FLEET_SECRET',
    'SERVER_MANAGER_URL',
    'TRUSTED_PROXIES',
    'PLATFORM_ORIGIN',
    'EDITOR_ORIGIN',
];

describe('.env.example', () => {
    const example = parseDotenv(readFileSync(EXAMPLE, 'utf8'));

    it('starts the service on its own', () => {
        // No process environment mixed in: a variable this file forgot must not be supplied by the
        // machine the suite happens to run on.
        expect(() => readEnv(example)).not.toThrow();
    });

    it.each(REQUIRED)('carries %s, which the schema has no default for', (name) => {
        expect(example).toHaveProperty(name);
        const { [name]: _dropped, ...without } = example;
        expect(() => readEnv(without)).toThrow();
    });
});
