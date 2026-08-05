// Shared types for the script/dispatch system.

export type Concurrency = 'concurrent' | 'ignore' | 'restart';
export type EventPhase = 'press' | 'release' | 'hold';
export type ScriptLocation = 'server' | 'client' | 'synced';

export interface HandlerOptions {
    concurrency?: Concurrency;
    on?: EventPhase;
}
