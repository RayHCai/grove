// The acceptance gate for this package's future binary codec, exercised across the package edge.
//
// It runs against `jsonCodec`, which transport already tests — so what this verifies is not the
// codec but the GATE: that `@platform/transport/testing` resolves, imports, and runs from inside
// this package. An acceptance gate the implementer cannot import is not a gate, and one nothing
// exercises rots silently.
//
// When `src/codec.ts` lands, `() => jsonCodec` becomes `() => binaryCodec`, and the binary codec
// must also supply the `opts` the suite takes for where codecs legitimately differ: a malformed
// frame in its own encoding, its own nesting builder, its own pollution and non-finite frames.

import { runCodecContract } from '@platform/transport/testing';
import { jsonCodec } from '@platform/transport';

runCodecContract(() => jsonCodec, { name: 'codec gate — jsonCodec across the protocol edge' });
