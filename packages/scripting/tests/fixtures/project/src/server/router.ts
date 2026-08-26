import { ServerScript, onRequest } from '@platform/core';
import type { Ctx, Game } from '@platform/core';

/** The module's default export, so the linker has to import it without a name to import. */
export default class Router extends ServerScript<Game> {
    @onRequest('ping')
    ping(_ctx: Ctx): number {
        return 1;
    }
}
