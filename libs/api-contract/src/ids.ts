import { z } from 'zod';

export const GameId = z.uuid().brand<'GameId'>();
export const PlayerId = z.uuid().brand<'PlayerId'>();
export const SessionId = z.uuid().brand<'SessionId'>();

export type GameId = z.infer<typeof GameId>;
export type PlayerId = z.infer<typeof PlayerId>;
export type SessionId = z.infer<typeof SessionId>;

/** An EC2 box, and one game process on that box — a session is placed by naming both. */
export const HostId = z.uuid().brand<'HostId'>();
export const InstanceId = z.uuid().brand<'InstanceId'>();

export type HostId = z.infer<typeof HostId>;
export type InstanceId = z.infer<typeof InstanceId>;

export const BuildJobId = z.uuid().brand<'BuildJobId'>();
export type BuildJobId = z.infer<typeof BuildJobId>;

/** A content hash, which is what names a built script chunk. */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/u);
export type ContentHash = z.infer<typeof ContentHash>;
