import { z } from 'zod';

const Env = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Binds loopback by default. This service is reachable from the fleet's own network and from
    // nowhere else, and a default of 0.0.0.0 is how that stops being true by accident.
    GAME_BUILDER_HOST: z.string().min(1).default('127.0.0.1'),
    GAME_BUILDER_PORT: z.coerce.number().int().positive().default(4002),

    /** The bearer `@grove/api` presents. Shared across the fleet, and never handed to a browser. */
    FLEET_SECRET: z.string().min(32),

    /** Where a finished build puts its artifacts, and where it registers the resulting bundle set. */
    UPLOAD_SERVICE_URL: z.url(),
    GAME_MANAGER_URL: z.url(),
});

export type Env = z.infer<typeof Env>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
    const parsed = Env.safeParse(source);
    if (!parsed.success) {
        throw new Error(`bad environment:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
}
