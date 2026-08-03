// Renderer errors.
//
// The renderer throws for CALLER BUGS and stays silent for RACES (§7):
//
//   throws   cross-surface parenting, cycles, a disabled surface, a world-surface text
//            node, init/option violations — all reachable only by writing wrong code
//   no-op    a stale handle, which arises legitimately from `entity.destroy()` mid-frame
//
// Dev builds log a stale handle once per id rather than throwing.

/** Every condition the renderer throws on. */
export type RendererErrorCode =
    /** `init` was called twice, or an operation needing a canvas ran before `init`. */
    | 'not-initialized'
    | 'already-initialized'
    /** An option was structurally invalid — a non-positive design size, a bad DPR cap. */
    | 'invalid-option'
    /** The named surface was left out of `enabledSurfaces`. */
    | 'surface-disabled'
    /** `parent` lives on a different surface than the child. */
    | 'cross-surface-parent'
    /** The requested parenting would make a node its own ancestor. */
    | 'cycle'
    /** `kind: 'text'` on a camera-transformed surface — use `createTextAsset` (§9.3). */
    | 'text-node-on-world-surface'
    /** A node descriptor was structurally invalid — a sprite with no texture name. */
    | 'invalid-node-desc'
    /** An asset manifest entry was structurally invalid. */
    | 'invalid-asset-entry';

/** A renderer failure with a machine-readable {@link RendererErrorCode}. */
export class RendererError extends Error {
    readonly code: RendererErrorCode;

    constructor(code: RendererErrorCode, message: string) {
        super(message);
        this.name = 'RendererError';
        this.code = code;
    }
}

/** Throws a {@link RendererError}. Keeps call sites to one line. */
export function rendererError(code: RendererErrorCode, message: string): never {
    throw new RendererError(code, message);
}
