// What both ends claim about the project, read off the manifest in one place: the server proves a
// joiner's claim against its own, so the two derivations must agree field for field.

import type { ProjectManifest } from '@platform/project';

/** The project half of the handshake — the bundle half is each end's own. */
export interface ProjectClaim {
    projectId: string;
    projectHash: string;
}

export function projectClaim(project: ProjectManifest | ProjectClaim): ProjectClaim {
    // A claim already: a host that never authored the world cannot derive one, and the player
    // origin is exactly that — it is handed two strings with its ticket and holds no manifest.
    if (!('contentHash' in project)) return project;
    // `contentHash` IS `projectHash` on the wire: the handshake compares a digest of what was
    // authored, and the two names are one value.
    return { projectId: project.projectId, projectHash: project.contentHash };
}
