// @platform/client/browser
// The DOM adapters, behind a subpath for the reason the renderer has them: the root barrel must yield the
// session and its seams without pulling a DOM adapter into the module graph, so a Node test imports the
// root and injects scripted seams while the browser app imports both.

export { createPerformanceClock, createRafFrameSource } from './frame-source.js';
export { createDomInputDevice, pollGamepads } from './input-device.js';
export type { DomInputOptions } from './input-device.js';
