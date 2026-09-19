// `cargo <task>` in the calling package, or a clear skip when there is no Rust toolchain here.
// cwd is the package pnpm invoked this from, and cargo walks up to the crate and the workspace.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'cargo',
    probe: ['--version'],
    install: 'Install Rust (https://rustup.rs)',
});
