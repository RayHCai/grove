import type { ProjectManifest } from '@platform/project';
import type { ServedAsset } from './protocol';

/** What the run's document cannot fetch for itself: every file the manifest names on this origin. */
export async function servedAssets(
    project: ProjectManifest,
    here: string = window.location.href,
    fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ServedAsset[]> {
    const origin = new URL(here).origin;
    const wanted = new Set<string>();
    for (const asset of project.assets) {
        const url = resolved(asset.url, here);
        // An asset this origin serves is cross-origin to a document with an origin of its own.
        if (url?.origin === origin) wanted.add(url.href);
    }
    const served = await Promise.all(
        [...wanted].map(async (url): Promise<ServedAsset | undefined> => {
            const response = await fetch(url, { credentials: 'omit' }).catch(() => undefined);
            if (response?.ok !== true) return undefined;
            return {
                url,
                contentType: response.headers.get('content-type') ?? 'application/octet-stream',
                bytes: await response.arrayBuffer(),
            };
        }),
    );
    return served.filter((asset) => asset !== undefined);
}

function resolved(url: string, base: string): URL | undefined {
    try {
        return new URL(url, base);
    } catch {
        return undefined;
    }
}
