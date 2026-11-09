import { ASSET_MEDIA_TYPES, MAX_ASSET_BYTES, MAX_SOURCE_BYTES } from '@grove/api-contract';
import type { AssetMediaType, WorkspaceFile } from '@grove/api-contract';

/**
 * One file as the editor holds it while somebody is typing in it.
 *
 * A draft is what the editor owns; what the service holds is a key in a bucket, overwritten in
 * place. Nothing here names bytes: a save sends the text of what changed and the service answers
 * with the version it landed as.
 */
export interface DraftFile {
    path: string;
    contentType: string;
    /** The text, for a file the code editor can open; an asset carries bytes instead. */
    text: string | undefined;
    /** An asset's bytes once this tab holds them; a stored one stays in the bucket until it is needed. */
    bytes: Uint8Array | undefined;
    /** How big an asset is, which the saved set says before anybody fetches its bytes. */
    byteLength: number | undefined;
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
    ['oga', 'audio/ogg'],
    ['weba', 'audio/webm'],
    ['webm', 'audio/webm'],
    ['woff2', 'font/woff2'],
    ['woff', 'font/woff'],
    ['ttf', 'font/ttf'],
    ['otf', 'font/otf'],
]);

/** What a file whose extension this editor does not know is stored as: opaque bytes, not a guess. */
export const UNKNOWN_TYPE = 'application/octet-stream';

/** What a path is stored under. An unknown extension is opaque bytes rather than a guess. */
export function mediaTypeOf(path: string): string {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return TYPES.get(extension) ?? UNKNOWN_TYPE;
}

/** Whether the code editor can open this: text is editable, and everything else is an asset. */
export function isText(contentType: string): boolean {
    return contentType.startsWith('text/') || contentType === 'application/json';
}

/** Whether a type is one an asset may be uploaded as, since the edge serves whatever it was stored as. */
export function isAssetType(contentType: string): contentType is AssetMediaType {
    return (ASSET_MEDIA_TYPES as readonly string[]).includes(contentType);
}

/** Which Monaco grammar a path opens under; only TypeScript is registered, so the rest are plain. */
export function languageOf(path: string): string {
    const type = mediaTypeOf(path);
    return type === 'text/typescript' || type === 'text/javascript' ? 'typescript' : 'plaintext';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function draftFromText(path: string, text: string): DraftFile {
    return { path, contentType: mediaTypeOf(path), text, bytes: undefined, byteLength: undefined };
}

/** A file that arrived as bytes: decoded into text when it is one the editor can open. */
export function draftFromBytes(
    path: string,
    bytes: Uint8Array,
    contentType = mediaTypeOf(path),
): DraftFile {
    return isText(contentType)
        ? {
              path,
              contentType,
              text: decoder.decode(bytes),
              bytes: undefined,
              byteLength: undefined,
          }
        : { path, contentType, text: undefined, bytes, byteLength: bytes.byteLength };
}

/** An asset the service holds, known by the saved set alone until something needs its bytes. */
export function storedAsset(file: WorkspaceFile): DraftFile {
    return {
        path: file.path,
        contentType: file.contentType,
        text: undefined,
        bytes: undefined,
        byteLength: file.byteLength,
    };
}

export function bytesOf(draft: DraftFile): Uint8Array {
    return draft.bytes ?? encoder.encode(draft.text ?? '');
}

/** What a picked file is stored as: its extension where this editor knows it, else the browser's word. */
export function importTypeOf(name: string, reported: string): string {
    const known = mediaTypeOf(name);
    // The extension first: a browser reports what its OS registry says, and a .ts file is
    // `video/mp2t` there.
    return known !== UNKNOWN_TYPE || reported === '' ? known : reported.toLowerCase();
}

function megabytes(bytes: number): string {
    return `${String(Math.ceil((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

/** Why a picked file cannot join the game, said before it does, or nothing when it can. */
export function importRefusal(name: string, size: number, contentType: string): string | undefined {
    if (isText(contentType)) {
        return size > MAX_SOURCE_BYTES
            ? `${name} is ${megabytes(size)}, and a file of code can be at most ${megabytes(MAX_SOURCE_BYTES)}.`
            : undefined;
    }
    if (!isAssetType(contentType)) {
        return `${name} is not a kind of file a game can carry: use PNG, JPEG, GIF or WebP art, MP3, OGG, WAV or WebM sound, a WOFF2, WOFF, TTF or OTF font, or JSON.`;
    }
    if (size === 0) return `${name} is empty.`;
    if (size > MAX_ASSET_BYTES) {
        return `${name} is ${megabytes(size)}, and a file a game carries can be at most ${megabytes(MAX_ASSET_BYTES)}.`;
    }
    return undefined;
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

/** What is owed less the paths held back, which is what a save nobody asked for carries. */
export function without(pending: Pending, held: ReadonlyMap<string, string>): Pending {
    if (held.size === 0) return pending;
    return {
        upserted: new Set([...pending.upserted].filter((path) => !held.has(path))),
        removed: pending.removed,
    };
}
