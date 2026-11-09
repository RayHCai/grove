import type { ServedAsset, StageColors } from '../run/protocol';

/** The ground a run is drawn on, set through the style object since the policy allows no new rule. */
export function paint(colors: StageColors, scope: Document = document): void {
    scope.body.style.background = colors.background;
    scope.body.style.color = colors.foreground;
}

// A fetch of one of the editor's files is answered from the bytes handed over, since this
// document's origin is its own and the editor's answers it nothing without CORS.
export function serve(assets: readonly ServedAsset[], scope: typeof globalThis = globalThis): void {
    if (assets.length === 0) return;
    const held = new Map(assets.map((asset) => [asset.url, asset]));
    const fetch = scope.fetch.bind(scope);
    scope.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
        const asset = held.get(url.href);
        if (asset === undefined) return fetch(input, init);
        // A copy each time, since a response's body is spent once read.
        return new Response(asset.bytes.slice(0), {
            headers: { 'content-type': asset.contentType },
        });
    };
}
