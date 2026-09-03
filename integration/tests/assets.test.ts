// The asset table and the audio surface, driven through a game and read back off a client.
//
// Audio here is write-only: `sound` and `music` push a named effect into the runtime's sink and
// answer with a handle that holds nothing, so the sink is the only place playback is observable at
// all. Each case installs a recording one on the tab's own mirror — the seat a browser's audio layer
// occupies — and asserts on what arrived there rather than on state no call ever leaves behind.
//
// The asset readings come the other way, off `@serverState`: the declared table exists on the end
// that was handed a manifest, and that is the authority alone.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import { hud, withRuntime } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { gameField, newSession, runtimeOf, taggedIn } from './harness.js';
import {
    ASSETS_WORLD,
    ASSET_CHIME,
    ASSET_MARCH,
    ASSET_SPARKLE,
    ASSET_THEME,
    HANDLE_VOLUME,
    MUSIC_FADE,
    R,
    S,
    SCREEN_AUDIO,
    SOUND_VOLUME,
    TAG_SPEAKER,
    W,
} from '../dist/worlds/assets.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;

/** One call as the sink received it; `opts` is undefined for a verb that passes no payload. */
interface Effect {
    readonly name: string;
    readonly opts: unknown;
}

/** Stands in for the audio layer, which owns this seam and is absent in Node. */
function record(tab: Tab): Effect[] {
    const played: Effect[] = [];
    runtimeOf(tab).effects = {
        play: (name: string, opts?: unknown): void => {
            played.push({ name, opts });
        },
    };
    return played;
}

function payload(effect: Effect | undefined): Record<string, unknown> {
    return (effect?.opts ?? {}) as Record<string, unknown>;
}

/**
 * Re-opens the screen, which is what puts the registered class on it.
 *
 * `hud.open` wires whatever is registered at the moment it runs and the harness registers after its
 * own open, so the first open leaves the screen empty and this second one is what attaches `Stage`.
 */
function wireScreen(tab: Tab): void {
    withRuntime(runtimeOf(tab), () => {
        hud.close(SCREEN_AUDIO);
        hud.open(SCREEN_AUDIO);
    });
}

async function open(): Promise<{ session: Session; tab: Tab; played: Effect[] }> {
    const session = newSession(ASSETS_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    wireScreen(tab);
    await session.step(SETTLE);
    return { session, tab, played: record(tab) };
}

/** Two tabs in one process, for the pair of numbers that turns out to belong to neither. */
async function openPair(): Promise<{ session: Session; one: Tab; two: Tab }> {
    const session = newSession(ASSETS_WORLD);
    const one = await session.join('one');
    const two = await session.join('two');
    await session.live(one, two);
    wireScreen(one);
    wireScreen(two);
    await session.step(SETTLE);
    return { session, one, two };
}

/** Every press names the screen: a screen-hosted handler hears no other kind, and the Game hears both. */
async function press(session: Session, tab: Tab, widget: string): Promise<void> {
    session.press(tab, widget, SCREEN_AUDIO);
    await session.step(SETTLE);
}

/** A replicated reading, as this tab's own mirror holds it. */
function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

/** What the screen script wrote, read off the sink a browser's UI would draw from. */
function shown(tab: Tab, name: string): string | undefined {
    return tab.client.hud.widgetOf(name)?.text;
}

function speakerIn(tab: Tab): EntityId {
    const id = taggedIn(runtimeOf(tab), TAG_SPEAKER)[0];
    if (id === undefined) throw new Error('the speaker never reached the mirror');
    return id;
}

describe('the declared asset table', () => {
    it('answers a key with the kind and the meta the manifest gave it', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.readAsset);
        expect(reading<string>(tab, S.discReading)).toBe('disc|texture|24x24|0');
        // A texture declares no duration and an audio file no pixels, and each unset number reads
        // as zero rather than leaving the field undefined.
        expect(reading<string>(tab, S.chimeReading)).toBe('chime|audio|0x0|1.5');
    });

    it('answers null for a key nothing declared, rather than an empty asset', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.readAsset);
        expect(reading<string>(tab, S.missing)).toBe('null');
    });

    it('filters by kind, and unfiltered hands back every declared asset', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.readKinds);
        expect(reading<string>(tab, S.audioKeys)).toBe('chime,theme');
        expect(reading<string>(tab, S.everyKind)).toBe('audio,audio,clip,effect,font,texture');
    });

    it("drops each asset's url on the way in, so no script can ever read one", async () => {
        const { session, tab } = await open();
        await press(session, tab, W.readAsset);
        // The url is declared, travels to the client and is what the renderer fetches from — but the
        // runtime narrowing drops it and `Asset` is built from key, kind and meta, so the object a
        // creator holds has no such member at all.
        expect(reading<boolean>(tab, S.urlOnAsset)).toBe(false);
    });

    it('is empty on a client, however much art that client is drawing', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.readMirror);
        // The mirror loads its world with no assets declared in it, so a `ClientScript` asking for
        // the chime it can hear gets null — the table is the authority's and only the authority's.
        expect(shown(tab, R.mirror)).toBe('0|null');
    });
});

describe('a sound', () => {
    it('reaches the sink under its own name, carrying the key it was given', async () => {
        const { session, tab, played } = await open();
        await press(session, tab, W.playSound);
        expect(played.map((e) => e.name)).toEqual(['sound.play']);
        expect(payload(played[0])).toStrictEqual({ asset: ASSET_CHIME, opts: undefined });
        expect(session.trips).toEqual([]);
    });

    it('hands its options through untouched, including the entity it was placed at', async () => {
        const { session, tab, played } = await open();
        await press(session, tab, W.playSoundAt);
        const opts = payload(played[0])['opts'] as {
            at?: { entityId: EntityId };
            volume?: number;
            loop?: boolean;
        };
        expect(opts.volume).toBe(SOUND_VOLUME);
        expect(opts.loop).toBe(true);
        // The local handle, not the netId: the sink is downstream of the mirror and knows no wire.
        expect(opts.at?.entityId).toBe(speakerIn(tab));
    });

    it('stops everything with a call that carries no payload at all', async () => {
        const { session, tab, played } = await open();
        await press(session, tab, W.stopSounds);
        expect(played.map((e) => e.name)).toEqual(['sound.stopAll']);
        // Not an empty object: the verb names no asset, so there is nothing for one to hold.
        expect(played[0]?.opts).toBeUndefined();
    });
});

describe('music', () => {
    it('plays with its loop and fade, and the fade travels with the stop as well', async () => {
        const { session, tab, played } = await open();
        await press(session, tab, W.playMusic);
        expect(payload(played[0])).toStrictEqual({
            asset: ASSET_THEME,
            opts: { loop: true, fade: MUSIC_FADE },
        });

        await press(session, tab, W.stopMusic);
        expect(played[1]).toStrictEqual({ name: 'music.stop', opts: { fade: MUSIC_FADE } });
    });
});

describe('the handle a play hands back', () => {
    it('is one object every play in the process shares, and stopping it emits nothing', async () => {
        const { session, tab, played } = await open();
        await press(session, tab, W.readHandle);
        // A sound handle and a music handle compared: the same object, and the volume written on one
        // is read straight back off the other.
        expect(shown(tab, R.handle)).toBe(`true|${HANDLE_VOLUME}`);
        expect(played.map((e) => e.name)).toEqual(['sound.play', 'music.play']);
    });
});

describe('the master volumes', () => {
    it('belong to the process rather than to a world, so one tab mutes the other', async () => {
        const { session, one, two } = await openPair();
        await press(session, one, W.readVolume);
        expect(shown(one, R.volume)).toBe('1|1');

        await press(session, one, W.mute);
        await press(session, two, W.readVolume);
        expect(shown(two, R.volume)).toBe('0|0');

        // Put back from the other tab, which is the same claim run backwards.
        await press(session, two, W.unmute);
        await press(session, one, W.readVolume);
        expect(shown(one, R.volume)).toBe('1|1');
    });

    it('reach no sink, so a muted world emits exactly what an unmuted one does', async () => {
        const { session, tab, played } = await open();
        await press(session, tab, W.mute);
        await press(session, tab, W.playSound);
        // Nothing that leaves `sound.play` mentions volume: the master is a field the emit path
        // never reads, so muting is a promise made to a layer that is not there yet.
        expect(payload(played[0])).toStrictEqual({ asset: ASSET_CHIME, opts: undefined });
        await press(session, tab, W.unmute);
    });
});

describe("an entity's own effects", () => {
    it('name the entity they were called on, and reach the sink audio reaches', async () => {
        const { session, tab, played } = await open();
        const speaker = speakerIn(tab);
        await press(session, tab, W.emit);
        expect(played.map((e) => e.name)).toEqual(['animation', 'effect']);
        expect(payload(played[0])).toStrictEqual({ id: speaker, clip: ASSET_MARCH });
        expect(payload(played[1])).toStrictEqual({ id: speaker, name: ASSET_SPARKLE });
        expect(session.trips).toEqual([]);
    });
});
