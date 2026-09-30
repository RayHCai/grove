import { assetId, scriptId, templateId } from '@platform/project';
// The creator's own file, as text: it is a program of its own and this app never runs it.
// oxlint-disable-next-line import/default
import source from '../../creator/templates/top-down/src/player.ts?raw';
import { draftFromText } from '../files';
import type { GameTemplate } from './template';

const PLAYER_PATH = 'src/player.ts';

/** The same file as a script id names it: a module path carries no extension. */
const MODULE = PLAYER_PATH.replace(/\.ts$/u, '');

/**
 * The avatar's spawn key.
 *
 * Named by core rather than by this project: the roster mints a body from the template called
 * `player`, so a game with no such row is one where `spawn()` has nothing to build.
 */
const AVATAR = 'player';

/** A placeholder body, at a relative url the client fetches from this app's own `public/`. */
const AVATAR_ART = assetId('body');

const AVATAR_URL = '/avatar-square.svg';

/**
 * What a new game is: one file, one body, one rule.
 *
 * No camera script. The bounds below are the stage a game is authored against, so a camera left
 * where it starts already shows the whole world, and a follow would be a line doing nothing.
 */
export const TOP_DOWN: GameTemplate = {
    id: 'top-down',
    name: 'Top-down player',
    description: 'One player walking in four directions.',
    openPath: PLAYER_PATH,
    files: () => [draftFromText(PLAYER_PATH, source)],
    project: {
        settings: {
            simRate: 30,
            sendRate: 15,
            maxPlayers: 4,
            // Sixteen by nine at the stage a game is authored against, in world units.
            bounds: { left: -480, right: 480, top: 270, bottom: -270 },
            regions: [],
        },
        assets: [{ id: AVATAR_ART, kind: 'texture', url: AVATAR_URL }],
        templates: [
            {
                id: templateId(AVATAR),
                visual: { kind: 'sprite', texture: AVATAR_ART },
                scripts: [],
            },
        ],
        entities: [],
        // A game script rather than a template's: the rules are the world's, not one body's.
        gameScripts: [{ script: scriptId(`${MODULE}#Rules`) }],
    },
};
