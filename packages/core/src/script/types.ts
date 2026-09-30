export type Concurrency = 'concurrent' | 'ignore' | 'restart';
export type EventPhase = 'press' | 'release' | 'hold';
export type { ScriptLocation } from '@platform/project';

export interface HandlerOptions {
    concurrency?: Concurrency;
    on?: EventPhase;
}
