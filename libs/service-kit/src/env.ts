import { z } from 'zod';

/** Parses a service's environment, naming every bad variable at once rather than the first. */
export function parseEnv<Schema extends z.ZodType>(
    schema: Schema,
    source: NodeJS.ProcessEnv,
): z.output<Schema> {
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
        throw new Error(`bad environment:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
}

/** Which of a service's own variables name where it listens. */
export interface ListenNames {
    host: string;
    port: string;
}

/**
 * Fills a service's own listen variables from a platform-assigned `PORT` where they are unset.
 *
 * A platform that assigns a port routes to it from outside the container, so a service told one
 * also binds every interface; a host or port the deploy set itself always wins.
 */
export function withPlatformPort(source: NodeJS.ProcessEnv, names: ListenNames): NodeJS.ProcessEnv {
    const assigned = source.PORT;
    if (assigned === undefined || assigned === '') return source;
    return {
        ...source,
        [names.port]: source[names.port] ?? assigned,
        [names.host]: source[names.host] ?? '0.0.0.0',
    };
}
