import { z } from 'zod';
import { parseEnv, withPlatformPort } from '@grove/service-kit';

/** The seams a production process may not start without. */
export const PRODUCTION_SEAMS = ['DATABASE_URL', 'GAMES_BUCKET', 'REDIS_URL'] as const;

const Env = z
    .object({
        // No default: a value that decides whether the session cookie carries `secure` must not be one
        // a deploy can omit its way past.
        NODE_ENV: z.enum(['development', 'test', 'production']),
        API_HOST: z.string().min(1).default('0.0.0.0'),
        API_PORT: z.coerce.number().int().positive().default(4000),

        // Three seams with no value rather than no default: absent is what leaves each unattached in
        // development and test, and a production process refuses to start without them.
        DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/u }).optional(),
        /** The games bucket. Absent, and a save has nowhere to put a creator's file. */
        GAMES_BUCKET: z.string().min(1).optional(),
        /** Where a queued task is announced. Absent, and nothing is ever told a build was asked for. */
        REDIS_URL: z.url({ protocol: /^rediss?$/u }).optional(),

        /**
         * Where the edge serves the games bucket from, which is what a build's output is addressed by.
         *
         * Only `build/` and `assets/` are reachable through it, so a creator's source stays inside the
         * fleet. This service is the one place that knows the address: a worker that made one up would
         * be choosing where a joining browser fetches code from.
         */
        GAMES_CDN_URL: z.url(),

        AWS_REGION: z.string().min(1).default('us-east-1'),
        /** Set only where something other than AWS answers for the bucket, such as a local LocalStack. */
        S3_ENDPOINT: z.url().optional(),
        /** How long an asset's presigned PUT is good for; enough for a slow uplink and a big file. */
        ASSET_UPLOAD_TTL_S: z.coerce.number().int().positive().default(900),

        /** Signs the browser session cookie. */
        SESSION_SECRET: z.string().min(32),
        /** Signs the game-scoped tokens the allocator hands out, a different key, a smaller radius. */
        GAME_TOKEN_SECRET: z.string().min(32),
        /** The bearer the fleet's own services compare. A third key, a third blast radius. */
        FLEET_SECRET: z.string().min(32),

        /** Where the fleet router answers a placement. */
        SERVER_MANAGER_URL: z.url(),

        /** How often the sweeper looks for work nothing was ever told about. */
        TASK_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
        /** How long a task may sit unclaimed before its push is assumed lost and made again. */
        TASK_SWEEP_AFTER_MS: z.coerce.number().int().positive().default(60_000),

        // A peer not named here writes `X-Forwarded-For` itself, and a limit keyed on that hands one
        // caller as many buckets as they care to invent.
        TRUSTED_PROXIES: z.string().min(1),

        // Only the two origins that hold a logged-in person may send credentials. The player origin is
        // deliberately absent: it runs creator code and never calls this service.
        PLATFORM_ORIGIN: z.url(),
        EDITOR_ORIGIN: z.url(),
    })
    .superRefine((env, context) => {
        if (env.NODE_ENV !== 'production') return;
        for (const seam of PRODUCTION_SEAMS) {
            if (env[seam] === undefined) {
                context.addIssue({
                    code: 'custom',
                    path: [seam],
                    message: 'required in production, where an unattached seam is an outage',
                });
            }
        }
    });

export type Env = z.infer<typeof Env>;

/** `PORT`, where a platform assigns one, is the fallback for `API_PORT`. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
    return parseEnv(Env, withPlatformPort(source, { host: 'API_HOST', port: 'API_PORT' }));
}
