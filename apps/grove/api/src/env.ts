import { z } from 'zod';

const Env = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),

    /** Signs the browser session cookie. */
    SESSION_SECRET: z.string().min(32),
    /** Signs the game-scoped tokens the allocator hands out. A different key, a different blast radius. */
    GAME_TOKEN_SECRET: z.string().min(32),

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
