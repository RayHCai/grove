// AGENTS.md's comment rule held to what a change adds: `--staged` for the hook, `--base <ref>` for CI,
// and neither for a hand run over the working tree and every file git does not know yet.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A block this long is a paragraph, which the rule says belongs in a name or a smaller function. */
const MAX_COMMENT_LINES = 2;

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|go|rs)$/u;

/** The spec is prose that happens to compile; it is read as a document, not as code. */
function exempt(path) {
    return path.startsWith('docs/') || !CODE.test(path);
}

/** A line that is nothing but comment: a `//` line, or one line of a block comment. */
function commentOnly(line) {
    const text = line.trim();
    return /^(\/\/|\/\*|\*)/u.test(text);
}

/** A branch's first push names an all-zero `before`, and a manual run names none: both mean the tip. */
function baseOf(ref) {
    return ref === undefined || ref === '' || /^0+$/u.test(ref) ? 'HEAD~1' : ref;
}

function diff() {
    const args = ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--diff-filter=AM'];
    const staged = process.argv.includes('--staged');
    const at = process.argv.indexOf('--base');
    if (staged) args.push('--cached');
    else if (at >= 0) args.push(`${baseOf(process.argv[at + 1])}...HEAD`);
    else args.push('HEAD');
    // `core.safecrlf` off: a CRLF checkout of an `eol=lf` tree warns once per file, about nothing here.
    return execFileSync('git', ['-c', 'core.safecrlf=false', ...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
}

const handRun = !process.argv.includes('--staged') && !process.argv.includes('--base');

/** A file git does not know yet is wholly new, and only the hand run sees it before a commit does. */
function untracked() {
    return execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
    })
        .split('\n')
        .filter((p) => p !== '' && !exempt(p))
        .map((p) => {
            const lines = readFileSync(join(root, p), 'utf8').split(/\r?\n/u);
            return [
                `+++ b/${p}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map((l) => `+${l}`),
            ].join('\n');
        })
        .join('\n');
}

const problems = [];
let path = null;
let line = 0;
let runStart = 0;
let runLength = 0;

function closeRun() {
    if (path !== null && runLength > MAX_COMMENT_LINES) {
        problems.push(
            `${path}:${runStart}: a ${runLength}-line comment; AGENTS.md asks for one line that says why.`,
        );
    }
    runLength = 0;
}

for (const raw of (handRun ? `${diff()}\n${untracked()}` : diff()).split('\n')) {
    if (raw.startsWith('+++ ')) {
        closeRun();
        const target = raw.slice(4).replace(/^b\//u, '');
        path = target === '/dev/null' || exempt(target) ? null : target;
        continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (hunk) {
        closeRun();
        line = Number(hunk[1]);
        continue;
    }
    if (path === null || !raw.startsWith('+')) continue;
    const added = raw.slice(1).replace(/\r$/u, '');
    if (commentOnly(added)) {
        if (runLength === 0) runStart = line;
        runLength += 1;
    } else {
        closeRun();
    }
    line += 1;
}
closeRun();

if (problems.length > 0) {
    process.stderr.write(
        `${problems.join('\n')}\n\n${problems.length} comment block(s) over the rule.\n`,
    );
    process.exit(1);
}

process.stdout.write('Comments: every added comment is short.\n');
