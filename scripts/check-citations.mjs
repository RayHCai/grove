// The design-doc citation rule, in one place rather than once in `.github/workflows/ci.yml` and
// again in `lefthook.yml`: two greps of one rule are two chances for the gate and the hook to
// disagree about what is banned.
//
// Two things are checked. A `§` outside the documents that may hold one is a citation whose
// numbering the reader is not holding, and that is the ban. Inside `docs/`, where a citation is
// allowed, it must still resolve to a section of `docs/api_design.md` that exists — a reference
// that points at nothing is what the ban exists to prevent, and the only place it can still happen.
//
// With no arguments the whole tree is scanned. With paths, only those, which is what the hook hands
// it for a partial commit.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Matched with a trailing digit so a bare section sign in prose is not a citation.
const CITATION = /§ ?\d+(?:\.\d+)*/gu;
const DESIGN = 'docs/api_design.md';

/** True where a citation belongs: the docs themselves, and the prose that states the rule. */
function exempt(path) {
    return (
        path.startsWith('docs/') ||
        path === 'AGENTS.md' ||
        /(^|\/)(DESIGN\.md|README\.md|readme\.md)$/u.test(path)
    );
}

function tracked() {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
}

function read(path) {
    try {
        return readFileSync(join(root, path), 'utf8');
    } catch {
        // A path git still lists but the tree no longer has, which a rename mid-commit produces.
        return '';
    }
}

/** The section numbers `docs/api_design.md` actually defines, as `1`, `1.1`, `3.4`. */
function sections() {
    const found = new Set();
    for (const line of read(DESIGN).split('\n')) {
        const heading = /^#{2,6} (\d+(?:\.\d+)*)\.?\s/u.exec(line);
        if (heading) found.add(heading[1]);
    }
    return found;
}

const paths = process.argv.slice(2).map((p) => p.replaceAll('\\', '/').replace(/^\.\//u, ''));
const scanned = paths.length > 0 ? paths : tracked();
const problems = [];

for (const path of scanned.filter((p) => !exempt(p))) {
    read(path)
        .split('\n')
        .forEach((line, i) => {
            for (const hit of line.match(CITATION) ?? []) {
                problems.push(
                    `${path}:${i + 1}: ${hit.trim()} — state the constraint itself; the numbering drifts and the reader is not holding the doc.`,
                );
            }
        });
}

// Only worth running over the whole tree: a partial commit's staged paths need not include the doc
// a citation elsewhere in `docs/` resolves against.
if (paths.length === 0) {
    const defined = sections();
    for (const path of tracked().filter((p) => p.startsWith('docs/'))) {
        read(path)
            .split('\n')
            .forEach((line, i) => {
                for (const hit of line.match(CITATION) ?? []) {
                    const number = hit.replace('§', '').trim();
                    if (!defined.has(number))
                        problems.push(
                            `${path}:${i + 1}: §${number} names no section of ${DESIGN}.`,
                        );
                }
            });
    }
}

if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n\n${problems.length} citation problem(s).\n`);
    process.exit(1);
}

process.stdout.write(`Citations: ${scanned.length} file(s) clean.\n`);
