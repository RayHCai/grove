// The bound every service in the fleet puts on a correlation id a caller presented.

import { describe, expect, it } from 'vitest';
import * as contract from '../src/index.js';
import { REQUEST_ID_HEADER, REQUEST_ID_MAX_LENGTH, validRequestId } from '../src/request-id.js';

describe('the correlation header', () => {
    it('is spelled the way an inbound Node header key arrives', () => {
        expect(REQUEST_ID_HEADER).toBe(REQUEST_ID_HEADER.toLowerCase());
        expect(REQUEST_ID_HEADER).toBe('x-request-id');
    });

    it('carries the bound libs/go-grove mirrors', () => {
        expect(REQUEST_ID_MAX_LENGTH).toBe(64);
    });

    it('reaches a service through the package index, which is all a service imports', () => {
        expect(contract.REQUEST_ID_HEADER).toBe(REQUEST_ID_HEADER);
        expect(contract.REQUEST_ID_MAX_LENGTH).toBe(REQUEST_ID_MAX_LENGTH);
        expect(contract.validRequestId).toBe(validRequestId);
    });
});

describe('an id a caller presented', () => {
    it('is kept when it is a uuid, which is what the Go services mint', () => {
        expect(validRequestId('9f8c2b1a-0000-4000-8000-00000000abcd')).toBe(true);
    });

    it('is kept when it is a trace id or the hex the Rust services mint', () => {
        expect(validRequestId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true);
        expect(validRequestId('0000188c1f3a9b40_0000002a')).toBe(true);
    });

    it('is refused when it is empty, since an empty id names nothing', () => {
        expect(validRequestId('')).toBe(false);
    });

    it('is kept at the bound and refused one character past it', () => {
        expect(validRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH))).toBe(true);
        expect(validRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH + 1))).toBe(false);
    });

    it('is refused for anything a log line or a header could not carry unchanged', () => {
        for (const presented of ['has a space', 'new\nline', 'a:b', 'a/b', 'dro%70ped', 'ä']) {
            expect(validRequestId(presented)).toBe(false);
        }
    });

    it('is refused whole rather than trimmed to the part that would have passed', () => {
        expect(validRequestId('good-id\r\nx-injected: yes')).toBe(false);
    });
});
