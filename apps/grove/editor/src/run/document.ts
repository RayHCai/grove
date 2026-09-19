// `?raw` inlines the harness as text rather than bundling it as a module: the run frame has an
// origin of its own, so it can fetch nothing from this one, and every byte it runs has to be in the
// document itself.
import harness from './harness.js?raw';

export interface RunDocumentOptions {
    /** The emitted JavaScript, keyed by module name — `main.js`, `scripts/player.js`. */
    modules: Record<string, string>;
    entry: string;
    title: string;
    /** Only the ground the creator's own page is drawn over; the frame cannot read the editor's. */
    background: string;
    foreground: string;
}

/**
 * The payload as JSON a script element cannot be closed from the middle of.
 *
 * `<` is the only character that ends an element early, and in the output of `JSON.stringify` it
 * only ever appears inside a string — where `<` is the same character and closes nothing.
 */
function inert(payload: unknown): string {
    return JSON.stringify(payload).replaceAll('<', '\\u003c');
}

function escapeAttribute(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

/**
 * The whole of a local run, as one self-contained document.
 *
 * It is handed to a frame as `srcdoc` rather than served from a url, which is what lets the frame be
 * sandboxed without `allow-same-origin`: a document with an origin of its own can fetch nothing
 * from the editor's, so anything it fetched would have to be granted CORS — and a page that runs
 * creator code is the last page to grant it.
 */
export function runDocument({
    modules,
    entry,
    title,
    background,
    foreground,
}: RunDocumentOptions): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeAttribute(title)}</title>
<style>
html, body { margin: 0; height: 100%; }
body { background: ${background}; color: ${foreground};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
</style>
</head>
<body>
<script type="application/json" id="grove-run">${inert({ modules, entry })}</script>
<script>${harness}</script>
</body>
</html>`;
}

/**
 * The page a full-page run opens in: the same sandboxed frame, full bleed, and a relay.
 *
 * The frame's own messages cannot reach the editor from another window, so this page passes them
 * through in both directions — which is the whole of what it does.
 */
export function windowDocument(document: string, title: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeAttribute(title)}</title>
<style>html, body { margin: 0; height: 100%; background: #000; }
iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body>
<iframe title="${escapeAttribute(title)}" sandbox="allow-scripts" srcdoc="${escapeAttribute(document)}"></iframe>
<script>
(function () {
  var frame = document.querySelector('iframe');
  window.addEventListener('message', function (event) {
    if (event.source === frame.contentWindow) {
      if (window.opener) window.opener.postMessage(event.data, '*');
    } else if (event.source === window.opener) {
      frame.contentWindow.postMessage(event.data, '*');
    }
  });
})();
</script>
</body>
</html>`;
}
