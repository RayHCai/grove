# Conformance fixtures

One JSON document per wire shape, and one frozen token vector. Every language that carries a copy of
these shapes reads the same files, so a rename on any one side fails on all of them rather than at a
join.

`wire/` holds one compact document per shape, with its members in the order the Go structs declare
them, or the zod schema does for a shape no Go service carries. The Go suite unmarshals each it has a
struct for and re-marshals it, comparing bytes; the vitest suite parses every one with the matching
zod schema and compares the value, and holds `manifest.json` to the bytes `encodeManifest` writes. A member added to one copy
and not the other fails whichever suite the fixture no longer describes.

`session-token.json` holds tokens `signSessionToken` actually produced, with the payload each
covers spelled out. The signer is re-run against them on this side and the Go and Rust verifiers
check them on theirs, so a base64 variant, a key-order difference or a change to the signing input
fails in all three languages at once.
