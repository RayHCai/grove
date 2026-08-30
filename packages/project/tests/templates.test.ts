// Closing the template graph: the two refusals, and the legal shapes that must not cost what
// walking every path through them would.

import { describe, expect, it } from 'vitest';
import type { ProjectManifest, TemplateRecord } from '../src/index.js';
import { PROJECT_FORMAT_VERSION, ProjectFormatError, templateId, validate } from '../src/index.js';

/** A world of nothing but pivots, so the only thing under test is the child graph. */
function projectOf(templates: TemplateRecord[]): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'proj_graph',
        contentHash: 'sha256:graph',
        settings: {
            simRate: 60,
            sendRate: 20,
            maxPlayers: 8,
            bounds: { left: -100, right: 100, top: 100, bottom: -100 },
            regions: [],
        },
        assets: [],
        scriptModules: [],
        templates,
        entities: [],
        gameScripts: [],
    };
}

function pivot(id: string, children: string[]): TemplateRecord {
    return {
        id: templateId(id),
        visual: { kind: 'group' },
        scripts: [],
        children: children.map((child) => ({ template: templateId(child) })),
    };
}

/** `level` templates deep, each naming the next `fanout` times: fanout^(level-1) distinct paths. */
function ladder(level: number, fanout: number): TemplateRecord[] {
    const out: TemplateRecord[] = [];
    for (let step = 0; step < level; step += 1) {
        const next = step === level - 1 ? [] : Array.from({ length: fanout }, () => `t${step + 1}`);
        out.push(pivot(`t${step}`, next));
    }
    return out;
}

function refusal(templates: TemplateRecord[]): ProjectFormatError {
    try {
        validate(projectOf(templates));
    } catch (error) {
        if (error instanceof ProjectFormatError) return error;
        throw error;
    }
    throw new Error('validate accepted a template graph it should have refused');
}

describe('the template graph', () => {
    it('accepts a diamond, where two children name one leaf template', () => {
        const shared = [
            pivot('root', ['left', 'right']),
            pivot('left', ['leaf']),
            pivot('right', ['leaf']),
            pivot('leaf', []),
        ];
        expect(() => validate(projectOf(shared))).not.toThrow();
    });

    it('refuses a template that reaches itself, however long the loop is', () => {
        const looped = [pivot('a', ['b']), pivot('b', ['c']), pivot('c', ['a'])];
        expect(refusal(looped).message).toContain('template "a" contains itself');
    });

    it('accepts a subtree that nests exactly to the bound', () => {
        expect(() => validate(projectOf(ladder(8, 1)))).not.toThrow();
    });

    it('refuses a subtree one level past the bound', () => {
        expect(refusal(ladder(9, 1)).message).toContain('nests deeper than 8');
    });

    it('measures a wide graph once per template rather than once per path through it', () => {
        // 20^7 paths through a legal, acyclic, under-cap file. Completing at all is the assertion:
        // a walk that re-entered a template per path took over a minute on these 3 KB.
        expect(() => validate(projectOf(ladder(8, 20)))).not.toThrow();
    });
});
