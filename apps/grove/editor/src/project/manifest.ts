// The project manifest as the editor holds it: one file in the game, beside the creator's sources.
//
// It is a game's own file rather than editor state, because that is what a build reads — the
// settings gear writes it, a compile stamps the two parts it derives, and a publish hands the
// service the same bytes.

import { PROJECT_FORMAT_VERSION, migrate, validate } from '@platform/project';
import type { ProjectManifest, ProjectSettings, ScriptModule } from '@platform/project';
import type { DraftFile } from '../workspace/files';
import { draftFromText } from '../workspace/files';

/** Where a game keeps it. Hidden from the explorer: the gear is what opens it. */
export const PROJECT_PATH = 'project.json';

/**
 * A manifest less the two parts a compile derives from the code beside it.
 *
 * What a template seeds and what the gear edits. `scriptModules` restates the classes the sources
 * export and `contentHash` digests the result, so neither is anybody's to type.
 */
export type AuthoredProject = Omit<
    ProjectManifest,
    'formatVersion' | 'contentHash' | 'scriptModules'
>;

/** Whether this path is the manifest rather than something the creator wrote. */
export function isProjectFile(path: string): boolean {
    return path === PROJECT_PATH;
}

/**
 * The manifest a stored game holds.
 *
 * Migrated before it is checked, because a file below this build's format is moved forward and
 * only one above it is refused — a file on disk cannot be told to update.
 */
export function readProject(text: string): ProjectManifest {
    return validate(migrate(JSON.parse(text)));
}

/** The bytes a save sends. Four spaces and a closing newline, as every other file in the repo. */
export function writeProject(project: ProjectManifest): string {
    return `${JSON.stringify(project, null, 4)}\n`;
}

/** The manifest as a file, ready to be dropped into the draft set. */
export function projectDraft(project: ProjectManifest): DraftFile {
    return draftFromText(PROJECT_PATH, writeProject(project));
}

/** The gear's edit: settings replaced, everything the code declares left alone. */
export function withSettings(project: ProjectManifest, settings: ProjectSettings): ProjectManifest {
    return { ...project, settings };
}

/**
 * The manifest with the parts a compile derives put back on it.
 *
 * The hash covers what was authored — the manifest without it, and the text of every source — so
 * two games with the same settings and different code never claim to be the same version.
 */
export async function stamp(
    authored: AuthoredProject,
    scriptModules: readonly ScriptModule[],
    sources: ReadonlyMap<string, string>,
): Promise<ProjectManifest> {
    const project: Omit<ProjectManifest, 'contentHash'> = {
        ...authored,
        formatVersion: PROJECT_FORMAT_VERSION,
        scriptModules: [...scriptModules],
    };
    return { ...project, contentHash: await digest(project, sources) };
}

/** Whether two manifests differ in anything a compile stamps; a save is not worth an equal one. */
export function sameStamp(left: ProjectManifest, right: ProjectManifest): boolean {
    return (
        left.contentHash === right.contentHash &&
        JSON.stringify(left.scriptModules) === JSON.stringify(right.scriptModules)
    );
}

async function digest(
    project: Omit<ProjectManifest, 'contentHash'>,
    sources: ReadonlyMap<string, string>,
): Promise<string> {
    // Sorted, and every source named beside its text: the digest is of what was authored, so the
    // order the editor happens to hold files in must not reach it.
    const paths = [...sources.keys()].toSorted();
    const canonical = [
        JSON.stringify(project),
        ...paths.map((path) => `${path}\n${sources.get(path) ?? ''}`),
    ].join('\n');

    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
