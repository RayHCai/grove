# Grove — agent instructions

## Comments

Default to no comment. Comment only what the code cannot say itself.

- **One line, one sentence.** If it needs a paragraph, the code needs a better name or a smaller function.
- **Explain why, never what.** A constraint, a rejected alternative, a non-obvious invariant. Never restate
  the signature or narrate the steps below it.
- **No banners, no history.** No `// ---- setup ----` dividers, no "was X, now Y", no commented-out code.
- One-line JSDoc on exported API is fine — it reaches consumers through the editor.
- Applies to code you write or edit. Leave existing comments alone unless you're already changing that line.

## Docs

| Path                          | Holds                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| `docs/api_design.md`          | Creator-facing API and the reasoning behind it                |
| `docs/api_spec.ts`            | The authoritative TS surface — a spec artifact, never shipped |
| `packages/*/README.md`        | What that package owns                                        |
| `packages/renderer/DESIGN.md` | Renderer internals                                            |

Where design prose and the spec disagree, the spec wins. Change both in the same commit.

## Build

Requires Node 24 — pinned to 24.16.0 in `.node-version`, enforced by `engines` in `package.json`. If
`node -v` disagrees, prefix commands with `mise exec --`; on an older Node, `pnpm` fails with a corepack
error that never mentions the version.

`pnpm run lint | format:check | typecheck | build | test`
