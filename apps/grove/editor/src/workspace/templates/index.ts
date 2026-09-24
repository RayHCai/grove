// What a game with nothing in it opens as.
//
// A template is a record rather than a branch: a second one is a file beside `top-down.ts` and a
// line in the list below, and everything that reads them — the seed, the manifest the gear opens,
// the file the workbench opens on — already takes whichever it was handed.

import { TOP_DOWN } from './top-down';
import type { GameTemplate } from './template';

export type { GameTemplate, TemplateProject } from './template';
export { seedFrom } from './template';

/** Every template a new game may be seeded from, in the order a picker would list them. */
export const TEMPLATES: readonly GameTemplate[] = [TOP_DOWN];

/** The one a game is seeded from when nobody picked. */
export const DEFAULT_TEMPLATE: GameTemplate = TOP_DOWN;

/** The template with this id, or the default — a game naming one this build dropped still opens. */
export function templateById(id: string | undefined): GameTemplate {
    return TEMPLATES.find((template) => template.id === id) ?? DEFAULT_TEMPLATE;
}
