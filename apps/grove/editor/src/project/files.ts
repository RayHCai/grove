import { languageOf } from '../workspace/files';
import type { DraftFile } from '../workspace/files';

export interface ProjectFile {
    kind: 'file';
    /** Unique within the project, and the tail of the model URI the editor opens it under. */
    path: string;
    name: string;
    language: string;
    value: string;
}

export interface ProjectFolder {
    kind: 'folder';
    path: string;
    name: string;
    children: readonly ProjectNode[];
}

export type ProjectNode = ProjectFile | ProjectFolder;

function nameOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** Folders above files, then alphabetical — the order a creator scans a project in. */
function ordered(nodes: readonly ProjectNode[]): ProjectNode[] {
    return nodes.toSorted((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}

/**
 * The tree the explorer lists, built from the paths the game holds.
 *
 * A folder is not a thing a game stores — it is what the slashes in a path mean — so the tree is
 * derived on every render rather than kept beside the files and edited in step with them.
 */
export function treeOf(files: readonly ProjectFile[]): ProjectNode[] {
    const roots: ProjectNode[] = [];
    const folders = new Map<string, ProjectFolder & { children: ProjectNode[] }>();

    function folderAt(path: string): ProjectNode[] {
        if (path === '') return roots;
        const held = folders.get(path);
        if (held !== undefined) return held.children;

        const made = { kind: 'folder' as const, path, name: nameOf(path), children: [] };
        folders.set(path, made);
        folderAt(path.slice(0, Math.max(path.lastIndexOf('/'), 0))).push(made);
        return made.children;
    }

    for (const file of files) {
        const cut = file.path.lastIndexOf('/');
        folderAt(cut === -1 ? '' : file.path.slice(0, cut)).push(file);
    }

    for (const folder of folders.values()) folder.children = ordered(folder.children);
    return ordered(roots);
}

/** Every folder, so the explorer can open the tree on first paint. */
export function folderPaths(nodes: readonly ProjectNode[]): readonly string[] {
    return nodes.flatMap((node) =>
        node.kind === 'folder' ? [node.path, ...folderPaths(node.children)] : [],
    );
}

/** What a file that is not text reads as when a tab opens on it: a description, never bytes. */
function describe(file: DraftFile): string {
    const size = file.bytes?.byteLength ?? 0;
    return `${file.path} — ${String(size)} bytes of ${file.contentType}.\nAssets are carried, not edited.\n`;
}

/** One stored file as the explorer and the tab strip see it. */
export function asProjectFile(file: DraftFile): ProjectFile {
    return {
        kind: 'file',
        path: file.path,
        name: nameOf(file.path),
        language: file.text === undefined ? 'plaintext' : languageOf(file.path),
        value: file.text ?? describe(file),
    };
}
