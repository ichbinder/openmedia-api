import prisma from "./prisma.js";

/**
 * Records a service incident reactively. Called when an outbound call to a
 * dependency (e.g. nzb-service) fails. If an open incident for the same
 * (service, operation) already exists, lastSeenAt is bumped and occurrences
 * is incremented; otherwise a new open incident is created.
 *
 * Internally non-throwing: DB errors are caught and logged so callers in the
 * hot path never crash because incident bookkeeping failed.
 */
export async function recordIncident(
  service: string,
  operation: string,
  message: string,
): Promise<void> {
  try {
    const existing = await prisma.serviceIncident.findFirst({
      where: { service, operation, status: "open" },
      orderBy: { firstSeenAt: "desc" },
    });

    if (existing) {
      await prisma.serviceIncident.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          occurrences: { increment: 1 },
          message,
        },
      });
      return;
    }

    await prisma.serviceIncident.create({
      data: { service, operation, message },
    });
  } catch (err) {
    console.error(
      `[incidents] recordIncident failed for ${service}/${operation}:`,
      err,
    );
  }
}

/**
 * Resolves all open incidents for the given (service, operation) pair.
 * Called on the next successful call after a failure has been recorded.
 *
 * Internally non-throwing: DB errors are caught and logged.
 */
export async function resolveIncident(
  service: string,
  operation: string,
): Promise<void> {
  try {
    await prisma.serviceIncident.updateMany({
      where: { service, operation, status: "open" },
      data: { status: "resolved", resolvedAt: new Date() },
    });
  } catch (err) {
    console.error(
      `[incidents] resolveIncident failed for ${service}/${operation}:`,
      err,
    );
  }
}
