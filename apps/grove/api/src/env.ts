import { z } from 'zod';

const Env = z.object({
    // No default: a value that decides whether the session cookie carries `secure` must not be one
    // a deploy can omit its way past.
    NODE_ENV: z.enum(['development', 'test', 'production']),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),

    /** Signs the browser session cookie. */
    SESSION_SECRET: z.string().min(32),
    /** Signs the game-scoped tokens the allocator hands out. A different key, a different blast radius. */
    GAME_TOKEN_SECRET: z.string().min(32),
    /** The bearer the fleet's own services compare. A third key, a third blast radius. */
    FLEET_SECRET: z.string().min(32),

    /** Where the fleet router answers a placement. */
    SERVER_MANAGER_URL: z.url(),
    /** Where a publish puts the source, under the hash a build then names it by. */
    UPLOAD_SERVICE_URL: z.url(),
    /** Where a build is queued. */
    GAME_BUILDER_URL: z.url(),

    // A peer not named here writes `X-Forwarded-For` itself, and a limit keyed on that hands one
    // caller as many buckets as they care to invent.
    TRUSTED_PROXIES: z.string().min(1),

    // Only the two origins that hold a logged-in person may send credentials. The player origin is
    // deliberately absent: it runs creator code and never calls this service.
    PLATFORM_ORIGIN: z.url(),
    EDITOR_ORIGIN: z.url(),
});

export type Env = z.infer<typeof Env>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
    const parsed = Env.safeParse(source);
    if (!parsed.success) {
        throw new Error(`bad environment:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
}
