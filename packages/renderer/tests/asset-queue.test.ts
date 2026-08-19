import { describe, it, expect } from 'vitest';

import {
    AssetQueue,
    isAllowedAssetUrl,
    LOADER_ASSET_SCHEMES,
    REMOTE_ASSET_SCHEMES,
    validateAssetEntry,
} from '../src/asset-queue.js';
import { RendererError } from '../src/errors.js';
import type { AssetManifestEntry } from '../src/renderer.js';

function image(name: string, url = `/assets/${name}.png`): AssetManifestEntry {
    return { name, kind: 'image', url };
}

/** The retained manifest a restore merges against — insertion order is the upload order. */
function manifest(...entries: AssetManifestEntry[]): Map<string, AssetManifestEntry> {
    return new Map(entries.map((e) => [e.name, e]));
}

describe('AssetQueue coalescing', () => {
    it('is a per-name intent map, not a log: load -> unload -> load is a NET LOAD', () => {
        const q = new AssetQueue();
        const first = image('a', '/first.png');
        const last = image('a', '/last.png');

        q.load(first);
        q.unload('a');
        q.load(last);

        expect(q.size).toBe(1);
        expect(q.intentFor('a')).toEqual({ op: 'load', entry: last });
    });

    it('unload -> load -> unload is a NET UNLOAD', () => {
        const q = new AssetQueue();

        q.unload('a');
        q.load(image('a'));
        q.unload('a');

        expect(q.size).toBe(1);
        expect(q.intentFor('a')).toEqual({ op: 'unload' });
    });

    it('collapses a long thrash chain to the last intent and one entry', () => {
        const q = new AssetQueue();
        const final = image('a', '/final.png');

        for (let i = 0; i < 50; i += 1) {
            q.load(image('a', `/v${i}.png`));
            q.unload('a');
        }
        q.load(final);

        expect(q.size).toBe(1);
        expect(q.intentFor('a')).toEqual({ op: 'load', entry: final });
    });

    it('a repeated load keeps only the newest entry, by identity', () => {
        const q = new AssetQueue();
        const stale = image('a', '/stale.png');
        const fresh = image('a', '/fresh.png');

        q.load(stale);
        q.load(fresh);

        const intent = q.intentFor('a');
        expect(intent?.op).toBe('load');
        // Identity, not deep equality: the queue must not clone or merge entries.
        expect(intent?.op === 'load' && intent.entry).toBe(fresh);
    });

    it('intentFor is undefined for a name that was never queued', () => {
        const q = new AssetQueue();
        q.load(image('a'));

        expect(q.intentFor('b')).toBeUndefined();
    });

    it('size counts distinct NAMES, not operations', () => {
        const q = new AssetQueue();

        q.load(image('a'));
        q.load(image('b'));
        q.unload('a');
        q.load(image('a'));
        q.unload('b');
        q.unload('c');

        // 6 calls, 3 names.
        expect(q.size).toBe(3);
        expect(q.names()).toEqual(['a', 'b', 'c']);
    });
});

describe('AssetQueue ordering', () => {
    it('names() reports first-mention order, unchanged by re-queueing', () => {
        const q = new AssetQueue();

        q.load(image('a'));
        q.load(image('b'));
        q.load(image('c'));
        // Re-queueing 'a' must update its intent WITHOUT moving it to the back.
        q.unload('a');
        q.load(image('a'));

        expect(q.names()).toEqual(['a', 'b', 'c']);
    });

    it('names(out) truncates and refills the caller array, returning it', () => {
        const q = new AssetQueue();
        q.load(image('a'));
        q.unload('b');

        const out = ['stale', 'stale', 'stale'];
        const returned = q.names(out);

        expect(returned).toBe(out);
        expect(out).toEqual(['a', 'b']);
    });

    it('is deterministic across identical call sequences', () => {
        const build = (): AssetQueue => {
            const q = new AssetQueue();
            q.unload('z');
            q.load(image('m'));
            q.load(image('a'));
            q.unload('m');
            return q;
        };

        expect(build().names()).toEqual(build().names());
        expect(build().names()).toEqual(['z', 'm', 'a']);
    });
});

describe('AssetQueue.merge — retained manifest x queue (§10)', () => {
    it('retained with NO intent is re-uploaded', () => {
        const q = new AssetQueue();
        const hero = image('hero');

        const work = q.merge(manifest(hero));

        expect(work.toLoad).toEqual([hero]);
        expect(work.toUnload).toEqual([]);
    });

    it('retained + queued LOAD appears ONCE, using the queued entry', () => {
        const q = new AssetQueue();
        const retainedHero = image('hero', '/old/hero.png');
        const queuedHero = image('hero', '/new/hero.png');
        q.load(queuedHero);

        const work = q.merge(manifest(retainedHero));

        expect(work.toLoad).toHaveLength(1);
        // The queued entry is newer, so it wins — assert identity, not just the url.
        expect(work.toLoad[0]).toBe(queuedHero);
        expect(work.toUnload).toEqual([]);
    });

    it('retained + queued UNLOAD suppresses the re-upload — unload wins', () => {
        const q = new AssetQueue();
        const hero = image('hero');
        const tiles = image('tiles');
        q.unload('hero');

        const work = q.merge(manifest(hero, tiles));

        // 'hero' must NOT be resurrected: a level transition meant to drop it.
        expect(work.toLoad).toEqual([tiles]);
        expect(work.toUnload).toEqual(['hero']);
    });

    it('queued LOAD not retained is appended after the retained entries', () => {
        const q = new AssetQueue();
        const retained = image('hero');
        const added = image('boss');
        q.load(added);

        const work = q.merge(manifest(retained));

        expect(work.toLoad).toEqual([retained, added]);
        expect(work.toUnload).toEqual([]);
    });

    it('queued UNLOAD not retained is still reported — idempotent, not an error (§9.2)', () => {
        const q = new AssetQueue();
        q.unload('ghost');

        const work = q.merge(manifest());

        expect(work.toLoad).toEqual([]);
        expect(work.toUnload).toEqual(['ghost']);
    });

    it('handles all four retained x queued combinations in one merge', () => {
        const q = new AssetQueue();
        const retainedOnly = image('retainedOnly');
        const retainedStale = image('bothLoad', '/old.png');
        const retainedDropped = image('bothUnload');
        const queuedFresh = image('bothLoad', '/new.png');
        const queuedNew = image('queuedOnly');

        q.load(queuedFresh); // retained + queued load  -> queued entry
        q.unload('bothUnload'); // retained + queued unload -> suppressed, dropped
        q.load(queuedNew); // not retained + queued load -> appended
        q.unload('queuedGhost'); // not retained + queued unload -> reported

        const work = q.merge(manifest(retainedOnly, retainedStale, retainedDropped));

        expect(work.toLoad).toEqual([retainedOnly, queuedFresh, queuedNew]);
        expect(work.toLoad[1]).toBe(queuedFresh);
        expect(work.toUnload).toEqual(['bothUnload', 'queuedGhost']);
    });

    it('preserves retained-manifest order, then queue order', () => {
        const q = new AssetQueue();
        const r1 = image('r1');
        const r2 = image('r2');
        const r3 = image('r3');
        const q1 = image('q1');
        const q2 = image('q2');
        q.load(q2);
        q.load(q1);

        const work = q.merge(manifest(r3, r1, r2));

        expect(work.toLoad.map((e) => e.name)).toEqual(['r3', 'r1', 'r2', 'q2', 'q1']);
    });

    it('a re-declared retained name keeps its RETAINED slot, it is not appended', () => {
        const q = new AssetQueue();
        const freshMid = image('mid', '/new/mid.png');
        const tail = image('tail');
        // 'mid' is queued FIRST but sits in the MIDDLE of the retained manifest, so an
        // implementation that appended it instead of substituting in place would emit
        // ['head', 'last', 'mid', 'tail'] — a manifest that was merely re-declared during a
        // loss must re-upload in its original order (only genuinely new names move to the end).
        q.load(freshMid);
        q.load(tail);

        const work = q.merge(manifest(image('head'), image('mid', '/old/mid.png'), image('last')));

        expect(work.toLoad.map((e) => e.name)).toEqual(['head', 'mid', 'last', 'tail']);
        // In the retained slot, and it is the newer declaration.
        expect(work.toLoad[1]).toBe(freshMid);
        expect(work.toUnload).toEqual([]);
    });

    it('an empty queue merged against an empty manifest is empty work', () => {
        const work = new AssetQueue().merge(manifest());

        expect(work).toEqual({ toLoad: [], toUnload: [] });
    });

    it('is a pure query: the queue is untouched and two calls agree', () => {
        const q = new AssetQueue();
        q.load(image('boss'));
        q.unload('hero');

        const retained = manifest(image('hero'), image('tiles'));
        const before = q.names();
        const first = q.merge(retained);
        const second = q.merge(retained);

        expect(q.size).toBe(2);
        expect(q.names()).toEqual(before);
        expect(q.intentFor('hero')).toEqual({ op: 'unload' });
        expect(second).toEqual(first);
        // Fresh arrays each call, so a caller may sort or splice the result.
        expect(second.toLoad).not.toBe(first.toLoad);
        expect(second.toUnload).not.toBe(first.toUnload);
    });

    it('does not mutate the retained manifest', () => {
        const q = new AssetQueue();
        q.unload('hero');
        q.load(image('boss'));
        const retained = manifest(image('hero'));

        q.merge(retained);

        expect([...retained.keys()]).toEqual(['hero']);
    });
});

describe('AssetQueue.intendedHas (§10)', () => {
    it('answers the queue when it has an intent, ignoring GPU residency', () => {
        const q = new AssetQueue();
        q.load(image('willLoad'));
        q.unload('willUnload');

        // queued load  x resident false -> true  (about to exist)
        expect(q.intendedHas('willLoad', false)).toBe(true);
        // queued load  x resident true  -> true
        expect(q.intendedHas('willLoad', true)).toBe(true);
        // queued unload x resident true -> false (about to be dropped)
        expect(q.intendedHas('willUnload', true)).toBe(false);
        // queued unload x resident false -> false
        expect(q.intendedHas('willUnload', false)).toBe(false);
    });

    it('falls through to residency with no intent', () => {
        const q = new AssetQueue();

        expect(q.intendedHas('resident', true)).toBe(true);
        expect(q.intendedHas('absent', false)).toBe(false);
    });

    it('reflects a coalesced chain rather than the first call', () => {
        const q = new AssetQueue();
        q.unload('hero');
        expect(q.intendedHas('hero', true)).toBe(false);

        q.load(image('hero'));
        expect(q.intendedHas('hero', true)).toBe(true);

        q.unload('hero');
        expect(q.intendedHas('hero', true)).toBe(false);
    });
});

describe('AssetQueue.clear', () => {
    it('drops every pending intent and reverts intendedHas to residency', () => {
        const q = new AssetQueue();
        q.load(image('boss'));
        q.unload('hero');

        q.clear();

        expect(q.size).toBe(0);
        expect(q.names()).toEqual([]);
        expect(q.intentFor('boss')).toBeUndefined();
        expect(q.intentFor('hero')).toBeUndefined();
        expect(q.intendedHas('hero', true)).toBe(true);
        expect(q.intendedHas('boss', false)).toBe(false);
    });

    it('leaves the queue reusable, and merge then re-uploads the whole manifest', () => {
        const q = new AssetQueue();
        const hero = image('hero');
        q.unload('hero');
        q.clear();

        expect(q.merge(manifest(hero))).toEqual({ toLoad: [hero], toUnload: [] });

        q.load(image('boss'));
        expect(q.size).toBe(1);
    });

    it('is idempotent on an empty queue', () => {
        const q = new AssetQueue();

        q.clear();
        q.clear();

        expect(q.size).toBe(0);
    });
});

describe('isAllowedAssetUrl', () => {
    it('allows the ordinary case: a relative path', () => {
        for (const url of ['/assets/hero.png', 'hero.png', './a/b.png', '../up.png']) {
            expect(isAllowedAssetUrl(url, LOADER_ASSET_SCHEMES)).toBe(true);
            expect(isAllowedAssetUrl(url, REMOTE_ASSET_SCHEMES)).toBe(true);
        }
    });

    it('allows http and https under both policies', () => {
        expect(isAllowedAssetUrl('https://cdn.example.com/a.png', LOADER_ASSET_SCHEMES)).toBe(true);
        expect(isAllowedAssetUrl('http://cdn.example.com/a.png', LOADER_ASSET_SCHEMES)).toBe(true);
        expect(isAllowedAssetUrl('https://cdn.example.com/a.png', REMOTE_ASSET_SCHEMES)).toBe(true);
        expect(isAllowedAssetUrl('http://cdn.example.com/a.png', REMOTE_ASSET_SCHEMES)).toBe(true);
    });

    it('takes data: and blob: from the loader but not from a remote manifest', () => {
        const data = 'data:image/png;base64,iVBORw0KGgo=';
        const blob = 'blob:http://localhost/8f3c-1';

        expect(isAllowedAssetUrl(data, LOADER_ASSET_SCHEMES)).toBe(true);
        expect(isAllowedAssetUrl(blob, LOADER_ASSET_SCHEMES)).toBe(true);
        // A peer that can name one of these hands us bytes we never fetched.
        expect(isAllowedAssetUrl(data, REMOTE_ASSET_SCHEMES)).toBe(false);
        expect(isAllowedAssetUrl(blob, REMOTE_ASSET_SCHEMES)).toBe(false);
    });

    it('refuses file: and javascript: under every policy', () => {
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)']) {
            expect(isAllowedAssetUrl(url, LOADER_ASSET_SCHEMES)).toBe(false);
            expect(isAllowedAssetUrl(url, REMOTE_ASSET_SCHEMES)).toBe(false);
        }
    });

    it('refuses the lexical evasions a scheme pattern lets through', () => {
        // Leading whitespace and mixed case are trimmed and folded by the parser; the embedded
        // newline is the one a `^([a-z][a-z\d+\-.]*):` test reads as a relative path and allows.
        for (const url of [
            '  javascript:alert(1)',
            'JavaScript:alert(1)',
            'java\nscript:alert(1)',
        ]) {
            expect(isAllowedAssetUrl(url, LOADER_ASSET_SCHEMES)).toBe(false);
            expect(isAllowedAssetUrl(url, REMOTE_ASSET_SCHEMES)).toBe(false);
        }
    });
});

describe('validateAssetEntry — url schemes', () => {
    it('accepts a relative path, https and data:', () => {
        const urls = ['/assets/hero.png', 'https://cdn.example.com/hero.png', 'data:image/png,x'];
        for (const url of urls) {
            expect(() => validateAssetEntry({ name: 'hero', kind: 'image', url })).not.toThrow();
        }
    });

    it('rejects a disallowed scheme as invalid-asset-entry', () => {
        for (const url of ['javascript:alert(1)', 'java\nscript:alert(1)', 'file:///etc/passwd']) {
            const entry: AssetManifestEntry = { name: 'hero', kind: 'image', url };
            expect(() => validateAssetEntry(entry)).toThrow(RendererError);
            expect(() => validateAssetEntry(entry)).toThrow(/disallowed scheme/);
        }
    });
});
