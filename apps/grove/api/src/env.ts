import { z } from 'zod';
import type { TaskKind } from '@grove/api-contract';
import { parseEnv, withPlatformPort } from '@grove/service-kit';
import { ticketSigningKey } from '@grove/api-contract/tokens';

/** The seams a production process may not start without. */
export const PRODUCTION_SEAMS = ['DATABASE_URL', 'GAMES_BUCKET', 'REDIS_URL'] as const;

/** One secret per caller, so a box holding one can answer for nothing the others gate. */
export const SERVICE_SECRETS = [
    'SESSION_SECRET',
    'SERVER_MANAGER_SECRET',
    'BUILDER_SECRET',
    'ASSET_SERVICE_SECRET',
] as const;

const Secret = z.string().min(32);

const Env = z
    .object({
        // No default: what decides whether the session cookie carries `secure` must not be omitted.
        NODE_ENV: z.enum(['development', 'test', 'production']),
        API_HOST: z.string().min(1).default('0.0.0.0'),
        API_PORT: z.coerce.number().int().positive().default(4000),

        // Absent, not defaulted: development runs unattached, and production refuses to start.
        DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/u }).optional(),
        /** The games bucket. Absent, and a save has nowhere to put a creator's file. */
        GAMES_BUCKET: z.string().min(1).optional(),
        /** Where a queued task is announced. Absent, and nothing is ever told a build was asked for. */
        REDIS_URL: z.url({ protocol: /^rediss?$/u }).optional(),

        /** Where the edge serves the bucket, which is what a build's output is addressed by. */
        GAMES_CDN_URL: z.url(),

        AWS_REGION: z.string().min(1).default('us-east-1'),
        /** Set only where something other than AWS answers for the bucket, such as a local LocalStack. */
        S3_ENDPOINT: z.url().optional(),
        /** How long an asset's presigned PUT is good for; enough for a slow uplink and a big file. */
        ASSET_UPLOAD_TTL_S: z.coerce.number().int().positive().default(900),

        /** Signs the browser session cookie. */
        SESSION_SECRET: Secret,
        /** The Ed25519 seed tickets are signed with; only its public half leaves this service. */
        TICKET_SIGNING_KEY: z.string().refine(
            (seed) => {
                try {
                    ticketSigningKey(seed);
                    return true;
                } catch {
                    return false;
                }
            },
            { message: 'an Ed25519 seed: 32 bytes of unpadded base64url' },
        ),
        /** Gates the router both ways: placements and deployments out, its fleet reports in. */
        SERVER_MANAGER_SECRET: Secret,
        /** Gates builds: their claims and settles, the source they read, the output they store. */
        BUILDER_SECRET: Secret,
        /** Gates asset uploads' claims and settles, and nothing else. */
        ASSET_SERVICE_SECRET: Secret,

        /** Where the fleet router answers a placement and takes a deployment. */
        SERVER_MANAGER_URL: z.url(),

        /** How often the sweeper looks for work nothing was ever told about. */
        TASK_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
        /** How long a task may go unannounced before its push is assumed lost and made again. */
        TASK_SWEEP_AFTER_MS: z.coerce.number().int().positive().default(60_000),
        // How long a claim keeps a task from every other worker: under each worker's reclaim window
        // (a builder's 180 s, the asset service's 300 s), so a dead worker's task is free again.
        BUILD_LEASE_MS: z.coerce.number().int().positive().default(150_000),
        ASSET_UPLOAD_LEASE_MS: z.coerce.number().int().positive().default(240_000),

        // A peer not named here writes `X-Forwarded-For` itself, and a limit keyed on that hands one
        // caller as many buckets as they care to invent.
        TRUSTED_PROXIES: z.string().min(1),

        // Only the two origins that hold a logged-in person; the player origin runs creator code.
        PLATFORM_ORIGIN: z.url(),
        EDITOR_ORIGIN: z.url(),
    })
    .superRefine((env, context) => {
        const seen = new Map<string, string>();
        for (const name of SERVICE_SECRETS) {
            const twin = seen.get(env[name]);
            if (twin !== undefined) {
                context.addIssue({
                    code: 'custom',
                    path: [name],
                    message: `the same value as ${twin}, which would let either caller answer for both`,
                });
            }
            seen.set(env[name], name);
        }

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

/** How long one kind's claim holds before another worker may take the task back. */
export function leaseOf(
    env: Pick<Env, 'BUILD_LEASE_MS' | 'ASSET_UPLOAD_LEASE_MS'>,
    kind: TaskKind,
) {
    return kind === 'BUILD' ? env.BUILD_LEASE_MS : env.ASSET_UPLOAD_LEASE_MS;
}

/** `PORT`, where a platform assigns one, is the fallback for `API_PORT`. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
    return parseEnv(Env, withPlatformPort(source, { host: 'API_HOST', port: 'API_PORT' }));
}
