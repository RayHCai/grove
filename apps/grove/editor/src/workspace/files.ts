/**
 * One file as the editor holds it while somebody is typing in it.
 *
 * A draft is what the editor owns; what the service holds is a key in a bucket, overwritten in
 * place. Nothing here names bytes — a save sends the text of what changed and the service answers
 * with the version it landed as.
 */
export interface DraftFile {
    path: string;
    contentType: string;
    /** The text, for a file the code editor can open; an asset carries bytes instead. */
    text: string | undefined;
    /** The bytes, for a file that arrived as bytes. Exactly one of the two is set. */
    bytes: Uint8Array | undefined;
}

const TYPES: ReadonlyMap<string, string> = new Map([
    ['ts', 'text/typescript'],
    ['js', 'text/javascript'],
    ['json', 'application/json'],
    ['md', 'text/markdown'],
    ['txt', 'text/plain'],
    ['css', 'text/css'],
    ['html', 'text/html'],
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['wav', 'audio/wav'],
    ['mp3', 'audio/mpeg'],
    ['ogg', 'audio/ogg'],
]);

/** What a path is stored under. An unknown extension is opaque bytes rather than a guess. */
export function mediaTypeOf(path: string): string {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return TYPES.get(extension) ?? 'application/octet-stream';
}

/** Whether the code editor can open this: text is editable, and everything else is an asset. */
export function isText(contentType: string): boolean {
    return contentType.startsWith('text/') || contentType === 'application/json';
}

/** Which Monaco grammar a path opens under; only TypeScript is registered, so the rest are plain. */
export function languageOf(path: string): string {
    const type = mediaTypeOf(path);
    return type === 'text/typescript' || type === 'text/javascript' ? 'typescript' : 'plaintext';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function draftFromText(path: string, text: string): DraftFile {
    return { path, contentType: mediaTypeOf(path), text, bytes: undefined };
}

/** A file that arrived as bytes: decoded into text when it is one the editor can open. */
export function draftFromBytes(
    path: string,
    bytes: Uint8Array,
    contentType = mediaTypeOf(path),
): DraftFile {
    return isText(contentType)
        ? { path, contentType, text: decoder.decode(bytes), bytes: undefined }
        : { path, contentType, text: undefined, bytes };
}

export function bytesOf(draft: DraftFile): Uint8Array {
    return draft.bytes ?? encoder.encode(draft.text ?? '');
}

/**
 * What a save still owes the service.
 *
 * Paths rather than contents: the draft is the content, and this is only the record of which of
 * them have been written to since the last save landed. A path in neither set is one nobody has
 * touched, which is what makes a save a delta instead of the whole game.
 */
export interface Pending {
    upserted: ReadonlySet<string>;
    removed: ReadonlySet<string>;
}

export const NOTHING_PENDING: Pending = { upserted: new Set(), removed: new Set() };

export function isPending(pending: Pending): boolean {
    return pending.upserted.size > 0 || pending.removed.size > 0;
}

/** A path was written to, which takes back a delete of it that has not been saved yet. */
export function touched(pending: Pending, path: string): Pending {
    const removed = new Set(pending.removed);
    removed.delete(path);
    return { upserted: new Set(pending.upserted).add(path), removed };
}

/**
 * A path was removed.
 *
 * A file created and removed between two saves is dropped from both sets rather than being sent as
 * a delete: the service never heard of it, and naming it would be asking to remove somebody else's
 * file at that path.
 */
export function dropped(pending: Pending, path: string, saved: boolean): Pending {
    const upserted = new Set(pending.upserted);
    upserted.delete(path);
    const removed = new Set(pending.removed);
    if (saved) removed.add(path);
    return { upserted, removed };
}
