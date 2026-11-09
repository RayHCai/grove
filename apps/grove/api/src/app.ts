import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { NEXT_CURSOR_HEADER } from '@grove/api-contract';
import { ticketSigningKey } from '@grove/api-contract/tokens';
import { installServiceHandlers, serviceOptions } from '@grove/service-kit';
import { leaseOf, type Env } from './env.js';
import { unattachedFleet } from './fleet.js';
import type { Fleet } from './fleet.js';
import { credentialLimits, generalLimit } from './limits.js';
import { unattachedMailer } from './mailer.js';
import type { Mailer } from './mailer.js';
import { unattachedQueue } from './queue.js';
import type { TaskQueue } from './queue.js';
import { unattachedStores } from './records.js';
import type { Stores } from './records.js';
import { allocatorRoutes } from './routes/allocator.js';
import { assetRoutes } from './routes/assets.js';
import { authRoutes } from './routes/auth.js';
import { fleetBuildRoutes } from './routes/build.js';
import { fleetRoutes } from './routes/fleet.js';
import { gameRoutes, gameSettingsRoutes } from './routes/games.js';
import { playerRoutes } from './routes/players.js';
import { publishingRoutes } from './routes/publishing.js';
import { socialRoutes } from './routes/social.js';
import { fleetTaskRoutes, taskRoutes } from './routes/tasks.js';
import { workspaceRoutes } from './routes/workspace.js';
import { MemorySessions } from './sessions.js';
import type { Sessions } from './sessions.js';
import { unattachedSocial } from './social.js';
import type { Social } from './social.js';
import { unattachedStorage } from './storage.js';
import type { Storage } from './storage.js';

/** How long a session lasts without a request, which every request moves on. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Every seam `buildApp` hands out, each to only the scopes that read it; absent is unattached. */
export interface Dependencies extends Stores {
    sessions: Sessions;
    fleet: Fleet;
    storage: Storage;
    queue: TaskQueue;
    mailer: Mailer;
    social: Social;
}

/** What registers at THIS level is a capability, not a policy: each scope adds its own gate. */
export async function buildApp(
    env: Env,
    attached: Partial<Dependencies> = {},
): Promise<FastifyInstance> {
    const deps: Dependencies = {
        ...unattachedStores,
        sessions: new MemorySessions(SESSION_TTL_MS),
        fleet: unattachedFleet,
        storage: unattachedStorage,
        queue: unattachedQueue,
        mailer: unattachedMailer,
        social: unattachedSocial,
        ...attached,
    };

    const app = Fastify({
        ...serviceOptions(env.NODE_ENV),
        // The client address a limit keys on comes from the forwarded header of these peers alone.
        trustProxy: env.TRUSTED_PROXIES,
    }).withTypeProvider<ZodTypeProvider>();

    installServiceHandlers(app);

    await app.register(import('@fastify/cors'), {
        // Only origins that hold a logged-in person; the player origin runs creator code.
        origin: [env.PLATFORM_ORIGIN, env.EDITOR_ORIGIN],
        credentials: true,
        // The plugin's default is GET,HEAD,POST, which refuses every editor write's preflight.
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        exposedHeaders: [NEXT_CURSOR_HEADER],
    });

    await app.register(import('@fastify/cookie'));
    await app.register(import('@fastify/session'), {
        secret: env.SESSION_SECRET,
        // A session is minted by a sign-in alone, never for a caller who has not made one.
        saveUninitialized: false,
        store: deps.sessions,
        cookie: {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: env.NODE_ENV === 'production',
            maxAge: SESSION_TTL_MS,
        },
    });
    await app.register(import('@fastify/csrf-protection'), { sessionPlugin: '@fastify/session' });

    // Global, so a new route starts limited; fleet routes opt out, their bearer being their gate.
    await app.register(import('@fastify/rate-limit'), generalLimit());
    const credentials = credentialLimits(app);

    await app.register(import('@fastify/swagger'), {
        openapi: {
            info: { title: 'Grove API', version: '0.0.0' },
            servers: [],
        },
        transform: jsonSchemaTransform,
    });
    // The routes and id formats of the one internet-facing service are reconnaissance off this box.
    if (env.NODE_ENV !== 'production') {
        await app.register(import('@fastify/swagger-ui'), { routePrefix: '/docs' });
    }

    // Polled by the balancer, so outside the limit, which rations traffic rather than liveness.
    app.get('/health', { schema: { hide: true }, config: { rateLimit: false } }, async () => ({
        ok: true,
    }));

    const { accounts, games, workspaces, tasks, fleetHistory, sessions, storage, queue } = deps;
    // Sibling scopes share nothing, so a fleet route beside a creator's inherits neither's gate.
    await app.register(authRoutes({ accounts, mailer: deps.mailer, sessions, credentials, env }), {
        prefix: '/v1/auth',
    });
    await app.register(playerRoutes({ accounts, sessions, credentials }), { prefix: '/v1' });
    await app.register(gameRoutes(games), { prefix: '/v1' });
    await app.register(gameSettingsRoutes(games, storage), { prefix: '/v1' });
    await app.register(socialRoutes(deps.social), { prefix: '/v1/social' });
    await app.register(workspaceRoutes({ games, workspaces, storage, queue }), { prefix: '/v1' });
    await app.register(assetRoutes(games, storage, env.ASSET_UPLOAD_TTL_S), { prefix: '/v1' });
    await app.register(publishingRoutes({ games, workspaces, tasks, queue }), { prefix: '/v1' });
    await app.register(taskRoutes(games, tasks), { prefix: '/v1' });
    await app.register(
        fleetTaskRoutes(
            {
                tasks,
                workspaces,
                storage,
                fleet: deps.fleet,
                leases: {
                    BUILD: leaseOf(env, 'BUILD'),
                    ASSET_UPLOAD: leaseOf(env, 'ASSET_UPLOAD'),
                },
            },
            env,
        ),
        { prefix: '/v1' },
    );
    await app.register(fleetBuildRoutes(tasks, storage, env), { prefix: '/v1' });
    await app.register(fleetRoutes(fleetHistory, env), { prefix: '/v1' });
    await app.register(
        allocatorRoutes({
            games,
            tasks,
            fleet: deps.fleet,
            signingKey: ticketSigningKey(env.TICKET_SIGNING_KEY),
        }),
        { prefix: '/v1' },
    );

    return app;
}
