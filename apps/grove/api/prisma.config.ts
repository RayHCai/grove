import { defineConfig } from 'prisma/config';

// `process.env` rather than Prisma's own `env()` helper: that helper throws while the config file is
// still loading, which makes every command — `--help` and `--version` included — fail on a machine
// with no database configured. The scripts supply the file with `node --env-file-if-exists`.
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: { url: process.env.DATABASE_URL ?? '' },
});
