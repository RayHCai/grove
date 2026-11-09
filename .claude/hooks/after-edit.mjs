// The per-file half of the pre-commit gate, run after each edit so a finding reaches the agent while
// the change is still in hand. Exit 2 is how a PostToolUse hook hands stderr back to the agent.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const LINTED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const file = input.tool_input?.file_path;
if (typeof file !== 'string' || !existsSync(file)) process.exit(0);

const path = relative(root, file).split(sep).join('/');
if (path.startsWith('..') || path.startsWith('node_modules/')) process.exit(0);

function run(args) {
    return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
}

const failures = [];

// Formatting is applied rather than reported: there is nothing to decide about it.
const prettier = run([
    join(root, 'node_modules/prettier/bin/prettier.cjs'),
    '--write',
    '--ignore-unknown',
    '--log-level=warn',
    path,
]);
if (prettier.status !== 0) failures.push(prettier.stderr || prettier.stdout);

if (LINTED.test(path)) {
    const oxlint = run([join(root, 'node_modules/oxlint/bin/oxlint'), '--deny-warnings', path]);
    if (oxlint.status !== 0) failures.push(oxlint.stdout || oxlint.stderr);
}

const citations = run([join(root, 'scripts/check-citations.mjs'), path]);
if (citations.status !== 0) failures.push(citations.stdout || citations.stderr);

if (failures.length > 0) {
    process.stderr.write(`${path}:\n${failures.join('\n')}`);
    process.exit(2);
}
