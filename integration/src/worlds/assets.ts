// A world whose whole game is the declared asset table and the two audio consts.
//
// The two halves are hosted where an honest answer exists. The manifest's assets are something the
// AUTHORITY was handed, so a Game script queries them and replicates each reading; playback is one
// tab's, so `sound`, `music` and the two `Entity` effect verbs are called from a screen script and
// land in that tab's own effect sink — which is where a browser's audio layer would have heard them.
//
// A `ClientScript` has no `@serverState`, so its readings go into HUD widgets instead.

import type { AssetRecord } from '@platform/project';
import { assetId, templateId } from '@platform/project';
import type { Asset, Ctx, Entity, Game, HUDScreen } from '@platform/engine';
import {
    ClientScript,
    ServerScript,
    assets,
    game,
    hud,
    music,
    onPlayerJoin,
    onPress,
    serverState,
    sound,
} from '@platform/engine';
import { ASSET_DISC, DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const ASSET_CHIME = 'chime';
export const ASSET_THEME = 'theme';
export const ASSET_MARCH = 'march';
export const ASSET_SPARKLE = 'sparkle';
export const ASSET_LABEL = 'label';
/** Named by nothing in the manifest, so `assets.get` has an honest miss to answer with. */
export const ASSET_ABSENT = 'nowhere';

export const CHIME_SECONDS = 1.5;
export const THEME_SECONDS = 90;
export const MARCH_SECONDS = 2;

export const TEMPLATE_SPEAKER = 'speaker';
export const TAG_SPEAKER = 'speaker';
/** Fixed, so the entity the effect verbs name is the same one every run. */
export const SPEAKER_AT = { x: 60, y: 0 };

export const SCRIPT_CURATOR = 'curator';
export const SCRIPT_STAGE = 'stage';
export const SCREEN_AUDIO = 'audio';

/** Six assets over five kinds, so `all(kind)` has something to leave out. */
export const DECLARED_ASSETS: readonly AssetRecord[] = [
    DISC_ASSET,
    {
        id: assetId(ASSET_CHIME),
        kind: 'audio',
        url: '/chime.ogg',
        meta: { duration: CHIME_SECONDS },
    },
    {
        id: assetId(ASSET_THEME),
        kind: 'audio',
        url: '/theme.ogg',
        meta: { duration: THEME_SECONDS },
    },
    {
        id: assetId(ASSET_MARCH),
        kind: 'clip',
        url: '/march.json',
        meta: { duration: MARCH_SECONDS },
    },
    { id: assetId(ASSET_SPARKLE), kind: 'effect', url: '/sparkle.json' },
    { id: assetId(ASSET_LABEL), kind: 'font', url: '/label.woff2' },
];

/** One widget per call, so a press names the verb and the name is what the test reads back. */
export const W = {
    readAsset: 'read-asset',
    readKinds: 'read-kinds',
    playSound: 'play-sound',
    playSoundAt: 'play-sound-at',
    stopSounds: 'stop-sounds',
    playMusic: 'play-music',
    stopMusic: 'stop-music',
    readHandle: 'read-handle',
    mute: 'mute',
    unmute: 'unmute',
    readVolume: 'read-volume',
    emit: 'emit',
    readMirror: 'read-mirror',
} as const;

/** Replicated readings, named so none of them collides with a member `Game` already owns. */
export const S = {
    discReading: 'discReading',
    chimeReading: 'chimeReading',
    audioKeys: 'audioKeys',
    everyKind: 'everyKind',
    missing: 'missing',
    urlOnAsset: 'urlOnAsset',
} as const;

/** Where the screen script puts what it read, since a client has no replicated field to use. */
export const R = {
    handle: 'handle-reading',
    volume: 'volume-reading',
    mirror: 'mirror-reading',
} as const;

export const SOUND_VOLUME = 0.4;
export const MUSIC_FADE = 0.5;
export const HANDLE_VOLUME = 0.3;

/** An asset flattened to text, because a replicated field carries a value and not an object. */
function reading(asset: Asset): string {
    return `${asset.key}|${asset.kind}|${asset.width}x${asset.height}|${asset.duration}`;
}

export class Curator extends ServerScript<Game> {
    @serverState discReading = '';
    @serverState chimeReading = '';
    @serverState audioKeys = '';
    @serverState everyKind = '';
    @serverState missing = 'unread';
    /** Starts true, so the reading below is a change rather than the initializer standing in for one. */
    @serverState urlOnAsset = true;

    @onPlayerJoin
    join(ctx: Ctx): void {
        ctx.player?.spawn();
    }

    @onPress(W.readAsset)
    doReadAsset(): void {
        const disc = assets.get(ASSET_DISC);
        const chime = assets.get(ASSET_CHIME);
        if (!disc || !chime) return;
        this.discReading = reading(disc);
        this.chimeReading = reading(chime);
        // Asked rather than read: `Asset` is built from key, kind and meta, so the url the manifest
        // declared reaches the renderer's own table and no script at all.
        this.urlOnAsset = 'url' in disc;
        this.missing = assets.get(ASSET_ABSENT) === null ? 'null' : 'something';
    }

    @onPress(W.readKinds)
    doReadKinds(): void {
        this.audioKeys = assets
            .all('audio')
            .map((a) => a.key)
            .toSorted()
            .join(',');
        this.everyKind = assets
            .all()
            .map((a) => a.kind)
            .toSorted()
            .join(',');
    }
}

/**
 * The audio half, on the one host that can honestly own it.
 *
 * Nothing here reads playback back, because there is none to read: every verb below pushes into the
 * runtime's effect sink and the handle it answers with holds no state.
 */
export class Stage extends ClientScript<HUDScreen> {
    @onPress(W.playSound)
    doPlaySound(): void {
        sound.play(ASSET_CHIME);
    }

    @onPress(W.playSoundAt)
    doPlaySoundAt(): void {
        const speaker = this.#speaker();
        if (speaker) sound.play(ASSET_CHIME, { at: speaker, volume: SOUND_VOLUME, loop: true });
    }

    @onPress(W.stopSounds)
    doStopSounds(): void {
        sound.stopAll();
    }

    @onPress(W.playMusic)
    doPlayMusic(): void {
        music.play(ASSET_THEME, { loop: true, fade: MUSIC_FADE });
    }

    @onPress(W.stopMusic)
    doStopMusic(): void {
        music.stop(MUSIC_FADE);
    }

    @onPress(W.readHandle)
    doReadHandle(): void {
        const one = sound.play(ASSET_CHIME);
        const two = music.play(ASSET_THEME);
        one.volume = HANDLE_VOLUME;
        one.stop();
        hud.text(R.handle, `${one === two}|${two.volume}`);
        // Put back, because that is one module-level object every play in this process hands out.
        one.volume = 1;
    }

    @onPress(W.mute)
    doMute(): void {
        sound.volume = 0;
        music.volume = 0;
    }

    @onPress(W.unmute)
    doUnmute(): void {
        sound.volume = 1;
        music.volume = 1;
    }

    @onPress(W.readVolume)
    doReadVolume(): void {
        hud.text(R.volume, `${sound.volume}|${music.volume}`);
    }

    @onPress(W.emit)
    doEmit(): void {
        const speaker = this.#speaker();
        if (!speaker) return;
        void speaker.play(ASSET_MARCH);
        speaker.playEffect(ASSET_SPARKLE);
    }

    /**
     * What this tab's own asset table answers, which is nothing: the mirror builds its runtime with
     * no assets declared in it, so the table `assets` resolves through here is empty for good.
     */
    @onPress(W.readMirror)
    doReadMirror(): void {
        const found = assets.get(ASSET_CHIME) === null ? 'null' : 'found';
        hud.text(R.mirror, `${assets.all().length}|${found}`);
    }

    // By tag rather than by template, which `find` does not query on — the placed speaker is the
    // only thing in this world carrying it.
    #speaker(): Entity | null {
        return game.find({ tag: TAG_SPEAKER })[0] ?? null;
    }
}

export const ASSETS_WORLD: World = defineWorld({
    id: 'assets',
    assets: DECLARED_ASSETS,
    scripts: [
        {
            id: SCRIPT_CURATOR,
            export: 'Curator',
            path: 'src/worlds/assets.ts',
            location: 'server',
            host: 'game',
            ctor: Curator,
        },
        {
            id: SCRIPT_STAGE,
            export: 'Stage',
            path: 'src/worlds/assets.ts',
            location: 'client',
            host: 'screen',
            ctor: Stage,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR), sprite(TEMPLATE_SPEAKER, [], 0x8fd694)],
    entities: [
        {
            id: 'the-speaker',
            template: templateId(TEMPLATE_SPEAKER),
            parent: null,
            transform: { x: SPEAKER_AT.x, y: SPEAKER_AT.y },
            tags: [TAG_SPEAKER],
            scripts: [],
        },
    ],
    gameScripts: [attach(SCRIPT_CURATOR)],
    screens: [{ name: SCREEN_AUDIO, script: Stage as never }],
});
