import type { FleetHistory } from '../records.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/** The fleet history tables, which nothing reads back on a request path. */
export function prismaFleetHistory(db: PrismaClient): FleetHistory {
    return {
        recordFleet: async (report) => {
            const hosts = report.hosts.map((host) => {
                const row = {
                    region: host.region,
                    liveness: host.liveness,
                    incarnation: host.incarnation,
                    runningInstances: host.capacity.runningInstances,
                    maxInstances: host.capacity.maxInstances,
                    cpuLoad: host.capacity.cpuLoad,
                    memoryFreeBytes: BigInt(host.capacity.memoryFreeBytes),
                    lastSeenAt: new Date(host.lastSeenAt),
                };
                // A box is named by the fleet it beat into, so one id comes back every report.
                return db.fleetHost.upsert({
                    where: { id: host.hostId },
                    create: { id: host.hostId, ...row },
                    update: row,
                });
            });

            // One transaction, because a snapshot its own events contradict is unreadable later.
            await db.$transaction([
                ...hosts,
                db.fleetHostEvent.createMany({
                    data: report.events.map((event) => ({
                        id: event.eventId,
                        hostId: event.hostId,
                        region: event.region,
                        kind: event.kind,
                        incarnation: event.incarnation,
                        at: new Date(event.at),
                        detail: event.detail ?? null,
                    })),
                    // The router's id, so a retried report lands on the rows it already wrote.
                    skipDuplicates: true,
                }),
            ]);
        },
    };
}
