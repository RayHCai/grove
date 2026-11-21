// The one place a client error goes: what a report says, what it is heard from, and how much of it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REPORTS, beaconTransport, installErrorReporting, reportError } from '../src/report.js';
import type { ErrorReport } from '../src/report.js';

let uninstall: (() => void) | undefined;

afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.restoreAllMocks();
});

function collect(target?: EventTarget): ErrorReport[] {
    const reports: ErrorReport[] = [];
    uninstall = installErrorReporting({
        transport: (report) => reports.push(report),
        ...(target === undefined ? {} : { target: target as Window }),
    });
    return reports;
}

describe('a report', () => {
    it('names the error, where it was caught, and the page without its query or fragment', () => {
        window.history.replaceState(null, '', '/play?ticket=secret#join=secret');
        const reports = collect();
        try {
            reportError(new TypeError('pip is undefined'), 'session');
        } finally {
            window.history.replaceState(null, '', '/');
        }
        expect(reports).toEqual([
            {
                source: 'session',
                message: 'TypeError: pip is undefined',
                stack: expect.stringContaining('pip is undefined') as unknown as string,
                page: `${window.location.origin}/play`,
            },
        ]);
    });

    it('says what was thrown when it was not an error at all', () => {
        const reports = collect();
        reportError('a bare string');
        expect(reports[0]).toMatchObject({ source: 'caught', message: 'a bare string' });
    });

    it('goes to the console until anything else is installed', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        reportError(new Error('nobody installed a sink'));
        expect(logged).toHaveBeenCalledWith(
            '[grove:caught] Error: nobody installed a sink',
            expect.any(String),
        );
    });
});

describe('the window hooks', () => {
    it('hear an uncaught error and an unhandled rejection, and nothing once undone', () => {
        const target = new EventTarget();
        const reports = collect(target);

        const thrown = new Error('uncaught');
        target.dispatchEvent(Object.assign(new Event('error'), { error: thrown, message: 'x' }));
        target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'refused' }));
        expect(reports.map((report) => [report.source, report.message])).toEqual([
            ['window', 'Error: uncaught'],
            ['rejection', 'refused'],
        ]);

        uninstall?.();
        uninstall = undefined;
        target.dispatchEvent(Object.assign(new Event('error'), { error: thrown }));
        expect(reports).toHaveLength(2);
    });
});

describe('the beacon', () => {
    it('sends each report as JSON to the address it was given, and prints it too', () => {
        const sendBeacon = vi.fn(() => true);
        Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const report: ErrorReport = {
                source: 'window',
                message: 'Error: x',
                stack: undefined,
                page: 'https://grove.example/',
            };
            beaconTransport('https://errors.grove.example/collect')(report);
            expect(sendBeacon).toHaveBeenCalledWith(
                'https://errors.grove.example/collect',
                JSON.stringify(report),
            );
            expect(logged).toHaveBeenCalledOnce();
        } finally {
            Reflect.deleteProperty(navigator, 'sendBeacon');
        }
    });

    it('stops after its share, so a loop that throws every frame is not thousands of requests', () => {
        const sendBeacon = vi.fn(() => true);
        Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const send = beaconTransport('https://errors.grove.example/collect');
            const report: ErrorReport = {
                source: 'window',
                message: 'x',
                stack: undefined,
                page: '',
            };
            for (let count = 0; count < MAX_REPORTS + 5; count += 1) send(report);
            expect(sendBeacon).toHaveBeenCalledTimes(MAX_REPORTS);
            expect(logged).toHaveBeenCalledTimes(MAX_REPORTS + 5);
        } finally {
            Reflect.deleteProperty(navigator, 'sendBeacon');
        }
    });

    it('is what installing with an address sends through', () => {
        const sendBeacon = vi.fn(() => true);
        Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            uninstall = installErrorReporting({ beaconUrl: 'https://errors.grove.example/c' });
            reportError(new Error('beaconed'));
            expect(sendBeacon).toHaveBeenCalledTimes(1);
        } finally {
            Reflect.deleteProperty(navigator, 'sendBeacon');
        }
    });
});
