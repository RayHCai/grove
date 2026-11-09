import { PrismaPg } from '@prisma/adapter-pg';
import type { Stores } from '../records.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { prismaAccounts } from './accounts.js';
import { prismaFleetHistory } from './fleet-history.js';
import { prismaGames } from './games.js';
import { prismaTasks } from './tasks.js';
import { prismaWorkspaces } from './workspaces.js';

export { prismaSessions } from './sessions.js';

export function connect(databaseUrl: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/** Every record seam over one database, each still handed to only the scopes that read it. */
export function prismaStores(db: PrismaClient): Stores {
    return {
        accounts: prismaAccounts(db),
        games: prismaGames(db),
        workspaces: prismaWorkspaces(db),
        tasks: prismaTasks(db),
        fleetHistory: prismaFleetHistory(db),
    };
}
