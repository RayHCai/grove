import { describe, expect, it } from 'vitest';
import { apiUrl, configuredUrl } from '../src/env.js';
import { messageOf } from '../src/messages.js';

/** The shape `@grove/api-contract/client` throws, built here so this kit needs no contract. */
function refusal(code: string, message: string): Error {
    const error = new Error(message) as Error & { code: string };
    error.name = 'ApiError';
    error.code = code;
    return error;
}

describe('messageOf', () => {
    it('keeps the sentence the service wrote', () => {
        expect(messageOf(refusal('invalid', 'that title is too long'), 'fallback')).toBe(
            'that title is too long',
        );
    });

    it('says a network failure is the connection, and a rate limit is a wait', () => {
        expect(messageOf(refusal('unreachable', 'x'), 'fallback')).toMatch(/could not be reached/u);
        expect(messageOf(refusal('rate_limited', 'x'), 'fallback')).toMatch(/Wait a minute/u);
    });

    it('falls back for an internal failure and for anything that is not a refusal', () => {
        expect(messageOf(refusal('internal', 'stack trace'), 'fallback')).toBe('fallback');
        expect(messageOf(new Error('plain'), 'fallback')).toBe('fallback');
        expect(messageOf('a string', 'fallback')).toBe('fallback');
    });
});

describe('configuredUrl', () => {
    it('takes the value a build was told', () => {
        expect(configuredUrl('VITE_X', 'https://x.example', 'http://localhost:1', false)).toBe(
            'https://x.example',
        );
    });

    it('falls back only in a dev server', () => {
        expect(configuredUrl('VITE_X', undefined, 'http://localhost:1', true)).toBe(
            'http://localhost:1',
        );
        expect(configuredUrl('VITE_X', '', 'http://localhost:1', true)).toBe('http://localhost:1');
        expect(() => configuredUrl('VITE_X', undefined, 'http://localhost:1', false)).toThrow(
            /VITE_X is not set/u,
        );
    });
});

describe('apiUrl', () => {
    it('is what the build was told, or the local stack in dev', () => {
        expect(apiUrl('https://api.example', false)).toBe('https://api.example');
        expect(apiUrl(undefined, true)).toBe('http://localhost:4000');
        expect(() => apiUrl(undefined, false)).toThrow(/VITE_API_URL/u);
    });
});
