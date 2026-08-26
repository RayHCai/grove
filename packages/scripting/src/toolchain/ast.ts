// One shape for every node, because the pass below reaches nodes by key rather than by case: a
// syntax rolldown's parser adds later is walked correctly instead of silently skipped.

import { parseAst } from 'rolldown/parseAst';
import { BundleError } from '../errors.js';

export interface Node {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly [key: string]: unknown;
}

export function parseModule(text: string, file: string): Node {
    try {
        return parseAst(text, { lang: 'ts' }, file) as unknown as Node;
    } catch (err) {
        throw new BundleError(
            `${file} does not parse: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

export function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

export function nodeName(value: unknown): string | undefined {
    return isNode(value) && value.type === 'Identifier' && typeof value.name === 'string'
        ? value.name
        : undefined;
}

/**
 * Every child that is evaluated at run time, paired with the key it hangs off.
 *
 * Type syntax is dropped, and so are the identifier positions that name something rather than read
 * it — a member's `.property`, an object key, an import or export specifier, a label.
 */
export function forEachChild(node: Node, visit: (child: Node, key: string) => void): void {
    if (node.type.startsWith('TS')) {
        for (const key of TS_VALUE_KEYS) {
            const value = node[key];
            if (isNode(value)) visit(value, key);
        }
        return;
    }
    const skipped = NON_REFERENCE_KEYS[node.type];
    for (const [key, value] of Object.entries(node)) {
        if (POSITION_KEYS.has(key) || TYPE_KEYS.has(key)) continue;
        if (skipped?.includes(key) && node.computed !== true) continue;
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) visit(item, key);
        } else if (isNode(value)) {
            visit(value, key);
        }
    }
}

const POSITION_KEYS: ReadonlySet<string> = new Set(['type', 'start', 'end', 'range', 'loc']);

const TYPE_KEYS: ReadonlySet<string> = new Set([
    'typeAnnotation',
    'returnType',
    'typeParameters',
    'typeArguments',
    'superTypeArguments',
    'implements',
]);

// A type node holds no runtime reference except through these, which wrap an expression.
const TS_VALUE_KEYS: readonly string[] = ['expression'];

const NON_REFERENCE_KEYS: Readonly<Record<string, readonly string[]>> = {
    MemberExpression: ['property'],
    Property: ['key'],
    PropertyDefinition: ['key'],
    MethodDefinition: ['key'],
    AccessorProperty: ['key'],
    ImportSpecifier: ['imported', 'local'],
    ImportDefaultSpecifier: ['local'],
    ImportNamespaceSpecifier: ['local'],
    ExportSpecifier: ['local', 'exported'],
    LabeledStatement: ['label'],
    BreakStatement: ['label'],
    ContinueStatement: ['label'],
    MetaProperty: ['meta', 'property'],
};

/** Every name a destructuring or parameter pattern binds. */
export function patternNames(node: unknown, into: Set<string>): void {
    if (!isNode(node)) return;
    switch (node.type) {
        case 'Identifier':
            if (typeof node.name === 'string') into.add(node.name);
            return;
        case 'ObjectPattern':
            for (const property of asNodes(node.properties)) {
                patternNames(
                    property.type === 'RestElement' ? property.argument : property.value,
                    into,
                );
            }
            return;
        case 'ArrayPattern':
            for (const element of asNodes(node.elements)) patternNames(element, into);
            return;
        case 'AssignmentPattern':
            patternNames(node.left, into);
            return;
        case 'RestElement':
            patternNames(node.argument, into);
            return;
        default:
            // A TS-wrapped parameter (`x!: T`) hangs the binding off `expression`.
            patternNames(node.expression, into);
    }
}

export function asNodes(value: unknown): Node[] {
    return Array.isArray(value) ? value.filter(isNode) : [];
}

/** Offsets of each line start, for turning a node's `start` into a 1-based line and column. */
export function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

export function positionAt(
    starts: readonly number[],
    offset: number,
): { line: number; column: number } {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid]! <= offset) low = mid;
        else high = mid - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
}
