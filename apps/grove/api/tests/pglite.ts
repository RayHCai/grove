// A real Postgres in this process, built from the committed migrations: half of what the suites
// assert is a CHECK constraint or a partial index, which only a migration carries.

import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

export const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

const TABLES = [
    'Account',
    'PasswordCredential',
    'PasswordReset',
    'Session',
    'Game',
    'GameFile',
    'Task',
    'BuildArtifact',
    'FleetHost',
    'FleetHostEvent',
];

export interface Database {
    pg: PGlite;
    db: PrismaClient;
    url: string;
    reset(): Promise<void>;
    close(): Promise<void>;
}

/** A port nothing holds, so suites running side by side never share one server. */
async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });
}

/** Every migration in the order a deploy applies them, then a socket Prisma can dial. */
export async function migrate(pg: PGlite): Promise<void> {
    const steps = readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
    for (const step of steps) {
        await pg.exec(readFileSync(`${MIGRATIONS}/${step}/migration.sql`, 'utf8'));
    }
}

export async function database(): Promise<Database> {
    const pg = await PGlite.create();
    await migrate(pg);
    const port = await freePort();
    const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
    await server.start();
    const url = `postgresql://postgres:postgres@127.0.0.1:${String(port)}/postgres`;
    // One pooled connection: the socket server takes one, and closes a second under it.
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
    return {
        pg,
        db,
        url,
        // Truncated rather than rebuilt: one socket server takes one connection at a time.
        reset: async () => {
            await pg.exec(`TRUNCATE ${TABLES.map((table) => `"${table}"`).join(', ')} CASCADE`);
        },
        close: async () => {
            await db.$disconnect();
            await server.stop();
            await pg.close();
        },
    };
}
