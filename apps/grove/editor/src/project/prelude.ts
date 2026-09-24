// The boilerplate a creator never sees: the engine is declared to the workbench as globals, and
// the import that makes those names real is put back at compile time, above the file.
//
// One list, in both directions — `src/creator/globals.d.ts` is what the checker reads, and
// `@platform/scripting`'s `ENGINE_VALUES` is what a compiled module imports. The build service
// compiles from the same list, so what typechecks on screen is what compiles on a build box.

import { ENGINE_VALUES } from '@platform/scripting';
import type * as Engine from '@platform/engine';
// Text rather than a module with exports; the rule reads the file behind the query.
// oxlint-disable-next-line import/default
import globals from '../creator/globals.d.ts?raw';

export {
    ENGINE_MODULE,
    ENGINE_TYPES,
    ENGINE_VALUES,
    engineNamesIn,
    preludeFor,
    usesFreeName,
} from '@platform/scripting';

/** Where the workbench holds the declarations above; a lib path, not a file anyone opens. */
export const GLOBALS_PATH = 'file:///grove/globals.d.ts';

/** The declarations the workbench checks a creator's file against. */
export const GLOBALS_DTS: string = globals;

// This app is the one place that holds both the list and the engine, so it is where a name the
// engine renamed or stopped exporting fails a typecheck rather than a creator's game at run time.
// `@platform/scripting` cannot make this check itself: the engine depends on it, not the reverse.
ENGINE_VALUES satisfies readonly (keyof typeof Engine)[];
