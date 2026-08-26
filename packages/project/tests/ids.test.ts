// The real assertion here is `tsc -p tsconfig.test.json`: every case below compiles only because
// the assignment on the marked line is an error. The `expect` calls exist so a reader sees which
// invariant broke rather than one long list of TS errors.

import { describe, expect, it } from 'vitest';
import type { AssetId, ScriptId, TemplateId } from '../src/index.js';
import { assetId, scriptId, templateId } from '../src/index.js';

/**
 * Core's `EntityId` and protocol's `NetId`, declared verbatim rather than imported.
 *
 * Both of those packages depend on this one, so a devDependency back would close a cycle in the
 * workspace graph. What is under test is that the brand KEYS are disjoint, and a verbatim copy
 * carries that exactly — a shared or stringly-typed brand here would fail these cases just as a
 * real import would.
 */
type EntityId = number & { readonly __entityId: unique symbol };
type NetId = number & { readonly __netId: unique symbol };

describe('authoring ids', () => {
    it('reads as a string wherever a string is wanted', () => {
        const key: string = templateId('coin');
        expect(key).toBe('coin');
    });

    it('is not a raw string, so a bare key cannot drift into a typed field', () => {
        // @ts-expect-error — the brand is what a mint call adds; a literal has none.
        const fromRaw: TemplateId = 'coin';
        expect(fromRaw).toBe('coin');
    });

    it('is mutually unassignable with the other two', () => {
        // @ts-expect-error — a template key is not a script id.
        const asScript: ScriptId = templateId('coin');
        // @ts-expect-error — a script id is not an asset key.
        const asAsset: AssetId = scriptId('Pickup');
        // @ts-expect-error — an asset key is not a template key.
        const asTemplate: TemplateId = assetId('coin-art');
        expect([asScript, asAsset, asTemplate]).toHaveLength(3);
    });

    it('is mutually unassignable with both runtime handles', () => {
        // An authoring id survives save and load; a runtime handle is meaningless outside the
        // runtime that minted it, so confusing the two is a correctness bug and not a naming one.
        // @ts-expect-error — core's EntityId is not a template key.
        const templateFromEntity: TemplateId = 16_777_216 as EntityId;
        // @ts-expect-error — protocol's NetId is not a script id.
        const scriptFromNet: ScriptId = 16_777_216 as NetId;
        // @ts-expect-error — nor does either conversion work the other way.
        const entityFromTemplate: EntityId = templateId('coin');
        // @ts-expect-error — see above.
        const netFromAsset: NetId = assetId('coin-art');
        expect([templateFromEntity, scriptFromNet, entityFromTemplate, netFromAsset]).toHaveLength(
            4,
        );
    });
});
