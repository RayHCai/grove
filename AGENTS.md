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

| Path                   | Holds                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `docs/api_design.md`   | Creator-facing API and the reasoning behind it                                           |
| `docs/api_spec.ts`     | The authoritative TS surface — a spec artifact, never shipped                            |
| `packages/*/README.md` | What that package owns                                                                   |
| `packages/*/DESIGN.md` | That package's technical architecture — core, renderer, transport, protocol, sim, client |

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
- **Packages with no `DESIGN.md`** (`engine`, `glue`, `math`, `project`, `scripting`) keep their
  contract in `README.md` — update that; don't add a `DESIGN.md` uninvited.

## Tests

Every creator-facing API member carries **two** proofs, and neither substitutes for the other:

| Level       | Lives in                | Proves                                                                                                                    |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `packages/<pkg>/tests/` | The member does what it says, called against a directly-built runtime                                                     |
| Integration | `integration/`          | It does it **through a game** — authored in a manifest, run in a handler, and observed on a client that was told about it |

A unit test alone is not coverage. A method that moves an entity on the authority and never marks a
replication channel passes every unit test and is broken in every real game.

**One world per API component.** `integration/src/worlds/<component>.ts` holds that component's game — its
scripts and its `defineWorld` call — and `integration/tests/<component>.test.ts` drives it. A new component
means both files; widening one means widening its suite in the same commit.

- Reach the API the way a creator does: in a handler, on a host, entered through a real frame. A call made
  from the test body proves only that the method exists.
- Assert on the **mirror** (`runtimeOf(tab)`), not only on `session.sim.runtime`.
- Import a decorated world from `../dist/worlds/<name>.js`; only `tsc` lowers standard decorators.
- A member that turns out inert or unreachable is pinned **as that**, with the evidence for the claim.
  Never assert behaviour the platform does not have.

`docs/api_spec.ts` is the checklist: every member it declares is owed both levels.

## Build

Requires Node 24, pinned to 24.16.0 in `.node-version` — which `fnm`, `nvm`, `volta` and
`actions/setup-node` all read, so the pin needs no tool this repository installs. `engines` in
`package.json` states only the `>=24` floor, which is why the Node-26 determinism leg runs the
TypeScript suite without an engine warning. Below the floor `pnpm` prints one `[WARN] Unsupported
engine` line and carries on, so a mismatch surfaces as whatever the older runtime cannot do.

`pnpm run lint | format:check | typecheck | build | test`

Go and Rust ride those same gates: every native package carries a `package.json` whose scripts shell
to `scripts/go.mjs` or `scripts/cargo.mjs`, which skip with a line where the toolchain is absent and
fail where `GROVE_REQUIRE_TOOLCHAIN` names it. The Go half is **one module**, rooted at `go.mod`, so
`go build ./...` from the repository root is every Go package in the tree.

None of that needs Docker. Standing the product **up** does: `compose.yaml` at the root is the local
runtime, in three layers — the stores alone, `--profile app` for the services, `--profile fleet` for
one box end to end — and `readme.md` holds the commands and what each one is reached at.

## Subagent Policy

Use subagents selectively.

Prefer working directly when:

- the task is sequential or tightly coupled
- the task involves a small number of files
- you need to maintain detailed context across implementation steps
- the work can be completed with normal repository exploration and tool calls

Use a subagent when:

- the work is genuinely independent from the main task
- the task requires isolated context
- the task involves a large, parallelizable investigation
- parallel execution provides a meaningful speed or quality benefit

When delegating:

- Prefer one subagent over multiple subagents.
- Use Sonnet for routine exploration, implementation, and verification unless the task genuinely requires
  Opus-level reasoning.
- Do not spawn subagents solely to double-check work that you can verify yourself.
- Do not recursively spawn additional subagents unless clearly necessary.
- Keep subagent tasks narrowly scoped and give them a concrete deliverable.

For large refactors or architectural work, prefer maintaining the primary reasoning and implementation context
in the main agent rather than delegating tightly coupled work.
