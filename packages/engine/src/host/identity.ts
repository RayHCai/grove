// What both ends claim about the project they are running, read off the manifest in one place.
//
// The server proves a joiner's claim against its own before it allocates a `Player`, so the two
// derivations have to agree field for field; deriving them twice is how they stop agreeing.

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
