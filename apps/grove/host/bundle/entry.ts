// The bundle a session's isolate evaluates, for a world with no authored scripts.
//
// A real game replaces this file: it imports its own project manifest and script registry and hands
// `createSim` both. What cannot change is the last line — a host with no module loader reaches this
// bundle through one global, and `installIsolateEntry` is what puts it there.

import { installIsolateEntry, simFromConfig } from '@platform/sim';

installIsolateEntry(simFromConfig);
