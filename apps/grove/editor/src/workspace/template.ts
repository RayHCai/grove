import { draftFromText, type DraftFile } from './files';

/** The file a fresh game opens on, and the module a local run starts from. */
export const ENTRY_PATH = 'src/main.ts';

const mainTs = `// Press Play to run this. Your sprout grows a little every day.

import { grow } from './sprout';
import { Garden } from './garden';

const garden = new Garden('Pip');

for (let day = 1; day <= 7; day += 1) {
    garden.plant(grow(garden.sprout, 2));
    console.log(\`day \${day}: \${garden.sprout.name} is \${garden.sprout.height} tall\`);
}

// After a week of sun, Pip stands 15 tall. Try changing the sun.
`;

const sproutTs = `export interface Sprout {
    name: string;
    height: number;
}

/** A day of sun adds to a sprout's height and never shrinks it. */
export function grow(sprout: Sprout, sun: number): Sprout {
    return { name: sprout.name, height: sprout.height + Math.max(0, sun) };
}

export function isBlooming(sprout: Sprout): boolean {
    return sprout.height >= 12;
}
`;

const gardenTs = `import type { Sprout } from './sprout';

/** One patch of ground, holding the sprout the player is growing. */
export class Garden {
    sprout: Sprout;

    constructor(name: string) {
        this.sprout = { name, height: 1 };
    }

    plant(next: Sprout): void {
        this.sprout = next;
    }

    get tallest(): number {
        return this.sprout.height;
    }
}
`;

const hudTs = `import type { Sprout } from '../src/sprout';

/** Draws the height counter the player watches while the sprout grows. */
export function drawHeight(sprout: Sprout): string {
    return \`\${sprout.name}: \${sprout.height} tall\`;
}
`;

const gameConfigTs = `/** What the panel reads when it loads this project. */
export const game = {
    title: "Pip's Garden",
    entry: 'src/main.ts',
    maxPlayers: 4,
    simRate: 30,
    sendRate: 15,
};
`;

/**
 * What a game with nothing saved in it opens as.
 *
 * Several files across two folders rather than one script, deliberately: the entry imports its
 * neighbours, so the first Play a creator presses runs a module graph, and a project that grows a
 * second file is doing what the template already did.
 *
 * It is seeded into the editor and left unsaved. Opening an editor is not a reason to write to
 * somebody's game — the first save is the creator's.
 */
export function templateFiles(): DraftFile[] {
    return [
        draftFromText(ENTRY_PATH, mainTs),
        draftFromText('src/sprout.ts', sproutTs),
        draftFromText('src/garden.ts', gardenTs),
        draftFromText('hud/hud.ts', hudTs),
        draftFromText('game.config.ts', gameConfigTs),
    ];
}
