// The document a world plays in: the engine, a world booted over it, and a session mounted against
// that world, so no line of the creator's evaluates anywhere the editor's session can reach.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DESIGN_STAGE, GamePlayer } from '@grove/player';
import { bootPreview } from '@grove/player/preview';
import * as Engine from '@platform/engine';
import { openStage } from './frame';
import { entriesOf, link } from './link';
import { paint, serve } from './stage';

openStage(async (game, stage) => {
    if (game.mode !== 'world') throw new Error('this document runs a world, not plain TypeScript');
    paint(game.colors);
    serve(game.assets);

    const linker = link(game.modules, {
        host: { engine: Engine as unknown as Record<string, unknown>, console: stage.console },
    });
    const preview = bootPreview({
        project: game.project,
        scripts: await entriesOf(game.project, linker),
        onLog: (text) => stage.line('warn', text),
    });
    stage.controls({ pause: preview.pause, resume: preview.resume });

    const host = document.createElement('div');
    document.body.append(host);
    createRoot(host).render(
        createElement(GamePlayer, {
            authority: preview.authority,
            project: preview.project,
            name: game.name,
            design: DESIGN_STAGE,
            onReady: () => stage.status('running'),
            onRefused: (_reason, message) => {
                stage.line('error', message);
                stage.status('failed');
            },
        }),
    );
});
