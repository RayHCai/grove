// What a template is, and what seeding one produces: the game's files, and the manifest the
// settings gear opens on.

import type { ProjectManifest } from '@platform/project';
import { projectDraft, stamp } from '../../project/manifest';
import { scanScripts } from '../../project/scripts';
import type { DraftFile } from '../files';

/** A template's manifest: everything but the two parts a compile derives from the code. */
export type TemplateProject = Omit<
    ProjectManifest,
    'formatVersion' | 'projectId' | 'contentHash' | 'scriptModules'
>;

export interface GameTemplate {
    /** Stable across renames; what a picker keys on. */
    id: string;
    name: string;
    /** One line, as a picker lists it. */
    description: string;
    /** The file the workbench opens on, which is the one the creator reads first. */
    openPath: string;
    /** The game's files, at the paths the game stores them under. */
    files: () => DraftFile[];
    project: TemplateProject;
}

/**
 * A new game's whole file set: the template's sources, and the manifest beside them.
 *
 * The manifest's `scriptModules` are read back off those same sources rather than written out
 * here, so a template cannot declare a class it does not have — and the project id is the game's
 * own, which is what a build, a share link and a save file agree on.
 */
export async function seedFrom(
    template: GameTemplate,
    projectId: string,
): Promise<{ files: DraftFile[]; project: ProjectManifest }> {
    const files = template.files();
    const sources = new Map(
        files.flatMap((file) => (file.text === undefined ? [] : [[file.path, file.text] as const])),
    );
    const project = await stamp(
        { ...template.project, projectId },
        scanScripts([...sources].map(([path, text]) => ({ path, text }))).modules,
        sources,
    );
    return { files: [...files, projectDraft(project)], project };
}
