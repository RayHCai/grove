// `cargo <task>` in the calling package, or a clear skip when there is no Rust toolchain here.
//
// The repo's gates are one `pnpm run build | test | typecheck | lint` at the root, and a contributor
// working on the TypeScript half should not have to install Rust to run them. A skip says so on one
// line rather than failing with `cargo: not found`, which reads as a broken checkout.
//
// cwd is the package pnpm invoked this from, and cargo resolves the crate, the workspace and the
// pinned toolchain by walking up from there — so one copy of this file serves every crate.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'cargo',
    probe: ['--version'],
    install: 'Install Rust (https://rustup.rs)',
});
