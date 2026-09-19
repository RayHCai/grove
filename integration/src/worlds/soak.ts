// Written longhand rather than through `defineWorld`: it is also the suite's worked example of an
// authored project, so a reader gets the file an editor would have written.

import { BINDINGS, SCREEN_PANEL, SIM_RATE, WIDGET_SCORE } from '../globals.js';
import { PROJECT } from '../project.js';
import { CLIENT_SCRIPTS, SERVER_SCRIPTS } from '../registry.js';
import { Panel } from '../scripts/panel.js';
import type { World } from '../world.js';

export const SOAK: World = {
    project: PROJECT,
    server: SERVER_SCRIPTS,
    client: CLIENT_SCRIPTS,
    bindings: BINDINGS,
    screens: [{ name: SCREEN_PANEL, script: Panel as never }],
    simRate: SIM_RATE,
    mirrorWidget: WIDGET_SCORE,
};
