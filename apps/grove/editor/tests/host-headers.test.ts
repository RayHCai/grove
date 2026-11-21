// What the editor's host sends beside the files, which no `<meta>` policy can say for it.

import { describe, expect, it } from 'vitest';
import { hostHeaders } from '../preview.plugin';

describe('the headers a host sends', () => {
    it('let nothing frame the editor', () => {
        expect(hostHeaders('/')['content-security-policy']).toBe("frame-ancestors 'none'");
        expect(hostHeaders('/index.html')['content-security-policy']).toBe(
            "frame-ancestors 'none'",
        );
    });

    it('sandbox a run’s document even where no frame attribute does', () => {
        for (const page of ['/preview-plain-0a1b2c3d4e.html', '/@grove-preview/world.html']) {
            expect(hostHeaders(page)['content-security-policy']).toBe(
                "sandbox allow-scripts; frame-ancestors 'self'",
            );
        }
        // The runtime script beside it is not a document, and is framed by nothing.
        expect(hostHeaders('/assets/preview-plain-0a1b2c3d4e.js')['content-security-policy']).toBe(
            "frame-ancestors 'none'",
        );
    });

    it('stop every response being sniffed into another type', () => {
        expect(hostHeaders('/assets/index.js')['x-content-type-options']).toBe('nosniff');
    });
});
