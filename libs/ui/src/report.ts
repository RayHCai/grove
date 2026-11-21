/** One client error as a transport is handed it. */
export interface ErrorReport {
    /** Where it was caught: `render`, `window`, `rejection`, or the caller's own word. */
    source: string;
    message: string;
    stack: string | undefined;
    /** The page it happened on, without the query or fragment, either of which can carry a ticket. */
    page: string;
}

/** Where a report goes. */
export type ErrorTransport = (report: ErrorReport) => void;

/** How many reports one page beacons at most, since a game loop that throws does so every frame. */
export const MAX_REPORTS = 20;

/** The console, so an error nothing else hears of is at least visible to whoever opens devtools. */
export const consoleTransport: ErrorTransport = (report) => {
    // oxlint-disable-next-line no-console -- the console is this transport's whole job.
    console.error(`[grove:${report.source}] ${report.message}`, report.stack ?? '');
};

/** The console, and a beacon to this address, which still leaves a tab that is closing. */
export function beaconTransport(url: string): ErrorTransport {
    let sent = 0;
    return (report) => {
        consoleTransport(report);
        if (sent >= MAX_REPORTS || typeof navigator.sendBeacon !== 'function') return;
        sent += 1;
        // A string body goes as text/plain, which a cross-origin collector takes without a preflight.
        navigator.sendBeacon(url, JSON.stringify(report));
    };
}

let transport: ErrorTransport = consoleTransport;

function pageOf(): string {
    return typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`;
}

/** Hands one error to whichever transport is installed; the console until something else is. */
export function reportError(error: unknown, source = 'caught'): void {
    const report: ErrorReport =
        error instanceof Error
            ? {
                  source,
                  message: `${error.name}: ${error.message}`,
                  stack: error.stack,
                  page: pageOf(),
              }
            : { source, message: String(error), stack: undefined, page: pageOf() };
    try {
        transport(report);
    } catch {
        // A transport that throws has nowhere left to report that to.
    }
}

export interface ErrorReportingOptions {
    /** A collector to beacon every report to besides the console, such as a `VITE_*` address. */
    beaconUrl?: string | undefined;
    /** A transport of the app's own, which wins over `beaconUrl`. */
    transport?: ErrorTransport | undefined;
    /** The window whose uncaught errors are heard; a test hands in its own. */
    target?: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined;
}

/** Sends a window's uncaught errors and unhandled rejections to `reportError`, answering the undo. */
export function installErrorReporting({
    beaconUrl,
    transport: chosen,
    target = window,
}: ErrorReportingOptions = {}): () => void {
    transport =
        chosen ??
        (beaconUrl === undefined || beaconUrl === ''
            ? consoleTransport
            : beaconTransport(beaconUrl));
    const onError = (event: ErrorEvent): void =>
        reportError(event.error ?? event.message, 'window');
    const onRejection = (event: PromiseRejectionEvent): void =>
        reportError(event.reason, 'rejection');
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
        transport = consoleTransport;
    };
}
