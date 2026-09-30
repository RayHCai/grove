import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { installServiceHandlers, serviceOptions } from '@grove/service-kit';
import type { Env } from './env.js';

/** Whether this box is claiming builds, as the one route here reports it. */
export type Liveness = () => { ok: true } | { ok: false; reason: string };

/**
 * One route, because nothing calls this service: a build box claims work from a stream and settles
 * it against @grove/api, so what is served here is the liveness a host agent polls. A box whose
 * consumer is not running answers 503, so a host agent replaces it rather than trusting it.
 */
export async function buildApp(env: Env, liveness: Liveness): Promise<FastifyInstance> {
    const app = Fastify(serviceOptions(env.NODE_ENV)).withTypeProvider<ZodTypeProvider>();
    installServiceHandlers(app);

    app.get('/health', { schema: { hide: true } }, async (_request, reply) => {
        const live = liveness();
        return reply.code(live.ok ? 200 : 503).send(live);
    });

    return app;
}
