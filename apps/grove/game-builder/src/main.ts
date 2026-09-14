import { readEnv } from './env.js';

readEnv();

// A builder that accepts jobs it can only fail is worse than one that does not start, and no
// `Compiler` exists for `buildApp`'s queue to run a build with.
throw new Error('game-builder has no compiler attached; refusing to start');
