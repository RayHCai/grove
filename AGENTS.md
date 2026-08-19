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

| Path                   | Holds                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `docs/api_design.md`   | Creator-facing API and the reasoning behind it                                              |
| `docs/api_spec.ts`     | The authoritative TS surface — a spec artifact, never shipped                               |
| `packages/*/README.md` | What that package owns                                                                      |
| `packages/*/DESIGN.md` | That package's technical architecture — core, renderer, transport, protocol, server, client |

Where design prose and the spec disagree, the spec wins. Change both in the same commit.

**`packages/protocol/DESIGN.md` is authoritative for anything on the wire**, over both endpoints' documents.

## Design docs — read first, edit last

**Before writing code:** read the `DESIGN.md` of every package you will touch, and `protocol/DESIGN.md` too if
the change reaches the wire. It is the intent; the code is one attempt at it. Where they disagree, treat the
doc as the claim to check, not as noise to route around — and say which one you followed.

**Before finishing:** bring those same docs back in line with what you shipped, in the same commit. Untouched
docs are the failure mode, and so is a doc that grew a paragraph per commit.

### A `DESIGN.md` holds technical architecture and nothing else

Present tense, shipped code only: what each module owns, the seams and the direction of every dependency, the
data shapes and who may write them, the invariants and the constraint behind each, the ordering rules, the
named constants and their units. A reader holding the doc and the code cannot tell which was written first.

Three kinds of content are **banned** in every package. Delete them on sight, and never rebuild one under
another name:

- **No testing.** No test section, no test-file list, no test count, no test name, no fake or fixture, no "the
  test pins it". What the suite covers is the suite's to state, and a doc naming a test rots the day it is
  renamed.
- **No gaps.** No "not here", "present-tense gaps", "not implemented", TODO, roadmap, milestone or future-work
  section — and no unbuilt feature named in passing elsewhere either. State what the package **is**. A boundary
  is written as what the package does not own, in its scope line, never as a list of what is missing.
- **No history.** No postmortem, no corrections table, no changelog, no "previously X, now Y", no dated note. A
  sentence that turned out wrong is edited into the true one and nothing records that it was ever there — what
  the change corrected goes in the response and the commit message, where a reader can date it.

### Editing one

- **Edit the wrong sentence in place.** No new sections. The doc reads as if it always described the shipped code.
- **One line per change.** A behaviour change is a clause; a whole feature is rarely more than a sentence and a
  table row. If you need a paragraph, the design changed — say so in the response, not in prose padding.
- **No documented behaviour changed → no edit.** Say that instead of manufacturing one.
- **Packages with no `DESIGN.md`** (`engine`, `math`, `platform`) keep their contract in `README.md` — update
  that; don't add a `DESIGN.md` uninvited.

## Build

Requires Node 24 — pinned to 24.16.0 in `.node-version`, enforced by `engines` in `package.json`. If
`node -v` disagrees, prefix commands with `mise exec --`; on an older Node, `pnpm` fails with a corepack
error that never mentions the version.

`pnpm run lint | format:check | typecheck | build | test`
