// The object store's surface, and the hash format everything in it is named by.

import { describe, expect, it } from 'vitest';
import { ObjectHead, ObjectRef } from '../src/objects.js';

const HASH = '4e9a'.repeat(16);

const head = {
    hash: HASH,
    kind: 'asset',
    byteLength: 2048,
    contentType: 'image/png',
    storedAt: '2026-09-05T12:00:00.000Z',
};

describe('an object head', () => {
    it('round-trips a stored asset', () => {
        expect(ObjectHead.parse(head)).toEqual(head);
    });

    it('rejects a hash that is not 64 lowercase hex', () => {
        for (const hash of [HASH.toUpperCase(), HASH.slice(0, 63), HASH + '0', 'sha256:' + HASH]) {
            expect(ObjectHead.safeParse({ ...head, hash }).success).toBe(false);
        }
    });

    it('rejects a kind the store does not shelve', () => {
        expect(ObjectHead.safeParse({ ...head, kind: 'thumbnail' }).success).toBe(false);
    });
});

describe('an object ref', () => {
    it('pairs the permanent name with a fetchable url', () => {
        const ref = { hash: HASH, url: `https://objects.grove.example/o/${HASH}` };
        expect(ObjectRef.parse(ref)).toEqual(ref);
        expect(ObjectRef.safeParse({ hash: HASH, url: `/o/${HASH}` }).success).toBe(false);
    });
});
