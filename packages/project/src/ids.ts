/**
 * A template's spawn key — what `game.spawn('coin')` names and a template visual keys by.
 * Branded to stay unassignable with the other authoring ids and with `EntityId` / `NetId`.
 */
export type TemplateId = string & { readonly __templateId: unique symbol };

/** One script class, as an attachment names it. Identifies the class, not the module holding it. */
export type ScriptId = string & { readonly __scriptId: unique symbol };

/** One panel-loaded asset, as a template visual or an audio call names it. */
export type AssetId = string & { readonly __assetId: unique symbol };

/** Brands a raw key. The editor mints the string; the shape it must satisfy is `validate`'s. */
export function templateId(key: string): TemplateId {
    return key as TemplateId;
}

/** Brands a raw key. See {@link templateId}. */
export function scriptId(key: string): ScriptId {
    return key as ScriptId;
}

/** Brands a raw key. See {@link templateId}. */
export function assetId(key: string): AssetId {
    return key as AssetId;
}
