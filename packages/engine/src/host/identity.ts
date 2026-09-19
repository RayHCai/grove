// What both ends claim about the project, read off the manifest in one place: the server proves a
// joiner's claim against its own, so the two derivations must agree field for field.

import type { ProjectManifest } from '@platform/project';

/** The project half of the handshake — the bundle half is each end's own. */
export interface ProjectClaim {
    projectId: string;
    projectHash: string;
}

export function projectClaim(manifest: ProjectManifest): ProjectClaim {
    // `contentHash` IS `projectHash` on the wire: the handshake compares a digest of what was
    // authored, and the two names are one value.
    return { projectId: manifest.projectId, projectHash: manifest.contentHash };
}
