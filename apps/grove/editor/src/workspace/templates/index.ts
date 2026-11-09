// What a game with nothing in it opens as. A template is a record rather than a branch: whatever
// reads one (the seed, the gear's manifest, the file opened on) takes the one it was handed.

import { TOP_DOWN } from './top-down';
import type { GameTemplate } from './template';

export type { GameTemplate, TemplateProject } from './template';
export { seedFrom } from './template';

/** The one a game with nothing saved is seeded from. */
export const DEFAULT_TEMPLATE: GameTemplate = TOP_DOWN;
