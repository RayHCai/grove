import { z } from 'zod';
import { parseEnv, withPlatformPort } from '@grove/service-kit';

const Env = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Binds loopback by default. Nothing calls this service; it claims its work from a stream, so
    // what is bound here is the health endpoint a host agent polls, and a default of 0.0.0.0 is how
    // a box stops being private by accident. A platform-assigned `PORT` binds every interface.
    GAME_BUILDER_HOST: z.string().min(1).default('127.0.0.1'),
    GAME_BUILDER_PORT: z.coerce.number().int().positive().default(4002),

    /** The bearer this service presents settling a task. Fleet-wide, and never a browser's. */
    FLEET_SECRET: z.string().min(32),
    /** Where a task is settled, which is the only call this service makes to @grove/api. */
    API_URL: z.url(),

    /** The stream builds are claimed from. Absent, and this process has no work to do. */
    REDIS_URL: z.url({ protocol: /^rediss?$/u }).optional(),

    /**
     * What this box is called inside the consumer group. Two builders sharing a name share their
     * claims, so a deploy that forgets this gets the hostname rather than one value for every box.
     */
    BUILDER_NAME: z.string().min(1).default(''),

    // How long one compile may hold a claim before another box may take it back. A creator's game
    // is a handful of modules, so a build is under a minute and this is the window an infrastructure
    // failure is reclaimed inside rather than the time a compile is expected to need.
    BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),

    /** How long `tsc` may run on one build before it is killed and the attempt left for retry. */
    COMPILE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

    /**
     * How many boxes may try one build before it is settled as failed.
     *
     * A failed build is restarted whole rather than resumed, so without a ceiling a fault that
     * looks transient and is not becomes a game rebuilt forever. The count is the row's, so it
     * spans boxes: this is attempts at the task, not attempts by this process.
     */
    BUILD_ATTEMPTS: z.coerce.number().int().positive().default(3),
});

export type Env = z.infer<typeof Env>;

/** `PORT`, where a platform assigns one, is the fallback for `GAME_BUILDER_PORT`. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
    return parseEnv(
        Env,
        withPlatformPort(source, { host: 'GAME_BUILDER_HOST', port: 'GAME_BUILDER_PORT' }),
    );
}
