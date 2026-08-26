/**
 * A template's spawn key — what `game.spawn('coin')` names, and what a template visual is keyed by.
 *
 * Strings, not packed numbers, because an authoring id is written by an editor into a file a human
 * reads in a diff. The brand key is its own `unique symbol`, which makes the three authoring ids
 * mutually unassignable with each other and with the two RUNTIME handles they must never be
 * confused with — core's `EntityId` and protocol's `NetId`. That distinction is the whole reason
 * they are branded: an authoring id survives save, load and a rebuild of the world, while a runtime
 * handle is meaningless outside the runtime that minted it.
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
