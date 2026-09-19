// The acceptance gate for this package's future binary codec, exercised across the package edge.
// It runs against `jsonCodec`, so what it verifies is the GATE: that `@platform/transport/testing`
// resolves and runs from inside this package.

import { runCodecContract } from '@platform/transport/testing';
import { jsonCodec } from '@platform/transport';

runCodecContract(() => jsonCodec, { name: 'codec gate — jsonCodec across the protocol edge' });
