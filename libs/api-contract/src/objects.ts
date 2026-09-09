import { z } from 'zod';
import { ContentHash } from './ids.js';

export const ObjectKind = z.enum(['bundle', 'asset', 'source']);
export type ObjectKind = z.infer<typeof ObjectKind>;

/** Everything @grove/upload-service knows about one object without reading its bytes. */
export const ObjectHead = z.object({
    hash: ContentHash,
    kind: ObjectKind,
    byteLength: z.int().nonnegative(),
    contentType: z.string(),
    storedAt: z.iso.datetime(),
});
export type ObjectHead = z.infer<typeof ObjectHead>;

/** Where a caller fetches an object. The url expires; the hash is what names it forever. */
export const ObjectRef = z.object({
    hash: ContentHash,
    url: z.url(),
});
export type ObjectRef = z.infer<typeof ObjectRef>;
