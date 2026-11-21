// The policy a built platform page carries, and the headers its host sends beside it.

import { describe, expect, it } from 'vitest';
import { HOST_HEADERS, platformPolicy } from '../csp.plugin';

function directive(policy: string, name: string): string | undefined {
    return policy.split('; ').find((each) => each.startsWith(`${name} `));
}

describe('the platform page’s policy', () => {
    it('dials the API and nothing else, and frames nothing', () => {
        const policy = platformPolicy('<html></html>', 'https://api.grove.example/v1');
        expect(directive(policy, 'connect-src')).toBe(
            "connect-src 'self' https://api.grove.example",
        );
        expect(directive(policy, 'frame-src')).toBe("frame-src 'none'");
        expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    });

    it('admits an inline script by its hash alone, never as unsafe-inline', () => {
        const policy = platformPolicy('<head><script>window.x = 1;</script></head>', undefined);
        expect(directive(policy, 'script-src')).toMatch(
            /^script-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/u,
        );
        expect(policy).not.toContain('unsafe-inline');
    });

    it('reaches an error collector only when the build was told one', () => {
        expect(
            directive(
                platformPolicy('', 'https://api.grove.example', 'https://errors.grove.example/c'),
                'connect-src',
            ),
        ).toBe("connect-src 'self' https://api.grove.example https://errors.grove.example");
        expect(directive(platformPolicy('', undefined, ''), 'connect-src')).toBe(
            "connect-src 'self'",
        );
    });
});

describe('what the host sends', () => {
    it('forbids every frame and every sniffed type', () => {
        expect(HOST_HEADERS).toEqual({
            'content-security-policy': "frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
        });
    });
});
