// The rule is scoped, which is why it cannot be an oxlint rule: `Date.now()` is perfectly legal in
// a ClientScript and a refusal in a SyncedScript, and no lint config can express the difference.
// It is also lexical — a helper a synced script calls is not inside it, and the shim is what stands
// behind that edge.

import type { Diagnostic } from '../errors.js';
import { DeterminismError, formatDiagnostic } from '../errors.js';
import type { Redirect } from '../policy.js';
import { ALIASED_MATH, COMPUTED_MATH, DENIED_GLOBALS, DENIED_MATH } from '../policy.js';
import { asNodes, forEachChild, isNode, nodeName, patternNames, positionAt } from './ast.js';
import type { Node } from './ast.js';
import type { Analysis, Module } from './analyze.js';

/** Every denied reference inside a `SyncedScript` subclass, sorted by file and position. */
export function checkDeterminism(analysis: Analysis): Diagnostic[] {
    const found: Diagnostic[] = [];
    for (const mod of analysis.modules) {
        for (const klass of mod.classes) {
            if (klass.location !== 'synced') continue;
            new Walk(mod, klass.local, found).run(klass.node);
        }
    }
    return found.toSorted(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
    );
}

/** Fails the build, naming every refusal. */
export function assertDeterminism(analysis: Analysis): void {
    const diagnostics = checkDeterminism(analysis);
    if (diagnostics.length === 0) return;
    const lines = diagnostics.map((d) => `  ${formatDiagnostic(d)}`).join('\n');
    throw new DeterminismError(
        `${diagnostics.length} determinism ${diagnostics.length === 1 ? 'refusal' : 'refusals'}:\n${lines}`,
        diagnostics,
    );
}

class Walk {
    readonly #mod: Module;
    readonly #klass: string;
    readonly #out: Diagnostic[];
    readonly #scopes: Set<string>[];

    constructor(mod: Module, klass: string, out: Diagnostic[]) {
        this.#mod = mod;
        this.#klass = klass;
        this.#out = out;
        this.#scopes = [new Set(mod.bindings.keys())];
    }

    run(root: Node): void {
        this.#visit(root);
    }

    #visit(node: Node): void {
        if (node.type === 'Identifier') return this.#identifier(node);
        if (node.type === 'MemberExpression') return this.#member(node);

        const scope = scopeNames(node);
        if (scope) this.#scopes.push(scope);
        forEachChild(node, (child) => this.#visit(child));
        if (scope) this.#scopes.pop();
    }

    #identifier(node: Node): void {
        const name = node.name;
        if (typeof name !== 'string' || this.#shadowed(name)) return;
        if (name === 'Math') return this.#report(node, 'Math', ALIASED_MATH);
        const redirect = DENIED_GLOBALS.get(name);
        if (redirect) this.#report(node, name, redirect);
    }

    #member(node: Node): void {
        const object = node.object;
        const objectName = isNode(object) ? nodeName(object) : undefined;
        const member = node.computed === true ? undefined : nodeName(node.property);

        if (objectName && !this.#shadowed(objectName)) {
            if (objectName === 'Math') {
                if (member === undefined) {
                    this.#report(node, 'Math[…]', COMPUTED_MATH);
                    if (isNode(node.property)) this.#visit(node.property);
                    return;
                }
                const redirect = DENIED_MATH.get(member);
                if (redirect) this.#report(node, `Math.${member}`, redirect);
                return;
            }
            const redirect = DENIED_GLOBALS.get(objectName);
            if (redirect && member !== undefined) {
                return this.#report(node, `${objectName}.${member}`, redirect);
            }
        }
        forEachChild(node, (child) => this.#visit(child));
    }

    #shadowed(name: string): boolean {
        return this.#scopes.some((scope) => scope.has(name));
    }

    #report(node: Node, found: string, redirect: Redirect): void {
        const { line, column } = positionAt(this.#mod.lines, node.start);
        this.#out.push({
            file: this.#mod.file,
            line,
            column,
            klass: this.#klass,
            found,
            use: redirect.use,
            because: redirect.because,
        });
    }
}

/** The names a scope-creating node declares, or undefined for a node that creates no scope. */
function scopeNames(node: Node): Set<string> | undefined {
    const names = new Set<string>();
    switch (node.type) {
        case 'Program':
        case 'BlockStatement':
        case 'StaticBlock':
            declarationsIn(asNodes(node.body), names);
            return names;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
            const id = nodeName(node.id);
            if (id) names.add(id);
            for (const param of asNodes(node.params)) patternNames(param, names);
            return names;
        }
        case 'ClassDeclaration':
        case 'ClassExpression': {
            const id = nodeName(node.id);
            if (id) names.add(id);
            return names;
        }
        case 'CatchClause':
            patternNames(node.param, names);
            return names;
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement': {
            const head = node.init ?? node.left;
            if (isNode(head) && head.type === 'VariableDeclaration') {
                for (const declarator of asNodes(head.declarations)) {
                    patternNames(declarator.id, names);
                }
            }
            return names;
        }
        default:
            return undefined;
    }
}

function declarationsIn(statements: readonly Node[], into: Set<string>): void {
    for (const statement of statements) {
        switch (statement.type) {
            case 'VariableDeclaration':
                for (const declarator of asNodes(statement.declarations)) {
                    patternNames(declarator.id, into);
                }
                break;
            case 'FunctionDeclaration':
            case 'ClassDeclaration': {
                const id = nodeName(statement.id);
                if (id) into.add(id);
                break;
            }
            case 'ImportDeclaration':
                for (const specifier of asNodes(statement.specifiers)) {
                    const local = nodeName(specifier.local);
                    if (local) into.add(local);
                }
                break;
            default:
        }
    }
}
