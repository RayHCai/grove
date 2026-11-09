// The document a plain TypeScript run plays in: its graph, started at its entry, on a held clock.

import { gateClocks } from './clock';
import { openStage } from './frame';
import { link } from './link';
import { paint } from './stage';

openStage(async (game, stage) => {
    if (game.mode !== 'plain') throw new Error('this document runs plain TypeScript, not a world');
    paint(game.colors);
    document.title = game.title;
    stage.controls(gateClocks());
    await link(game.modules, { host: { console: stage.console } }).load(game.entry);
    stage.status('running');
});
