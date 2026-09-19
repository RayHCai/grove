import { z } from 'zod';

const Env = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Binds loopback by default. Nothing calls this service any more — it claims its work from a
    // stream — so what is bound here is the health endpoint a host agent polls, and a default of
    // 0.0.0.0 is how a box stops being private by accident.
    GAME_BUILDER_HOST: z.string().min(1).default('127.0.0.1'),
    GAME_BUILDER_PORT: z.coerce.number().int().positive().default(4002),

    /** The bearer this service presents settling a task. Fleet-wide, and never a browser's. */
    FLEET_SECRET: z.string().min(32),
    /** Where a task is settled, which is the only call this service makes to @grove/api. */
    API_URL: z.url(),

    /** The stream builds are claimed from. Absent, and this process has no work to do. */
    REDIS_URL: z.url({ protocol: /^rediss?$/u }).optional(),
    /** The games bucket a manifest is read from. Absent, and a claimed build can only fail. */
    GAMES_BUCKET: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    /** Set only where something other than AWS answers for the bucket, such as a local MinIO. */
    S3_ENDPOINT: z.url().optional(),

    /**
     * What this box is called inside the consumer group. Two builders sharing a name share their
     * claims, so a deploy that forgets this gets the hostname rather than one value for every box.
     */
    BUILDER_NAME: z.string().min(1).default(''),

    // How long one compile may hold a claim before another box may take it back. Fifteen minutes,
    // because a compile is minutes rather than seconds.
    BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
});

export type Env = z.infer<typeof Env>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
    const parsed = Env.safeParse(source);
    if (!parsed.success) {
        throw new Error(`bad environment:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
}
