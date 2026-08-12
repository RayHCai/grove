# Grove — agent instructions

## Comments

Default to no comment. Comment only what the code cannot say itself.

- **One line, one sentence.** If it needs a paragraph, the code needs a better name or a smaller function.
- **Explain why, never what.** A constraint, a rejected alternative, a non-obvious invariant. Never restate
  the signature or narrate the steps below it.
- **No banners, no history.** No `// ---- setup ----` dividers, no "was X, now Y", no commented-out code.
- **Never cite a design-doc section.** No `§4.1`, no "see §5 of DESIGN.md" — the numbering drifts and the
  reader is not holding the doc. State the constraint itself.
- One-line JSDoc on exported API is fine — it reaches consumers through the editor.
- Applies to code you write or edit. Leave existing comments alone unless you're already changing that line.

## Docs

| Path                   | Holds                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| `docs/api_design.md`   | Creator-facing API and the reasoning behind it                                 |
| `docs/api_spec.ts`     | The authoritative TS surface — a spec artifact, never shipped                  |
| `packages/*/README.md` | What that package owns                                                         |
| `packages/*/DESIGN.md` | That package's internals — core, renderer, transport, protocol, server, client |

Where design prose and the spec disagree, the spec wins. Change both in the same commit.

**`packages/protocol/DESIGN.md` is authoritative for anything on the wire**, over both endpoints' documents.

## Design docs — read first, edit last

**Before writing code:** read the `DESIGN.md` of every package you will touch, and `protocol/DESIGN.md` too if
the change reaches the wire. It is the intent; the code is one attempt at it. Where they disagree, treat the
doc as the claim to check, not as noise to route around — and say which one you followed.

**Before finishing:** bring those same docs back in line with what you shipped, in the same commit. Untouched
docs are the failure mode, and so is a doc that grew a paragraph per commit.

- **Edit the wrong sentence in place.** No new sections, no changelog entries, no "previously X, now Y", no
  dated notes. The doc reads as if it always described the shipped code.
- **One line per change.** A behaviour change is a clause; a whole feature is rarely more than a sentence and a
  table row. If you need a paragraph, the design changed — say so in the response, not in prose padding.
- **A doc that asserted the opposite gets one row**, not a rewrite: in the final postmortem section (`protocol`
  §11, `client` §14 — the pattern for every package, not those two only), record the claim, the corrected fact,
  and the test that caught it. Correct rather than delete: a reader who sees what a sentence replaced knows how
  far to trust the ones beside it.
- **Confirmed claims count too** — a line saying a risky assertion was checked and held is worth a correction.
- **No documented behaviour changed → no edit.** Say that instead of manufacturing one.
- **Packages with no `DESIGN.md`** (`engine`, `math`, `platform`) keep their contract in `README.md` — update
  that; don't add a `DESIGN.md` uninvited.

## Build

Requires Node 24 — pinned to 24.16.0 in `.node-version`, enforced by `engines` in `package.json`. If
`node -v` disagrees, prefix commands with `mise exec --`; on an older Node, `pnpm` fails with a corepack
error that never mentions the version.

`pnpm run lint | format:check | typecheck | build | test`
