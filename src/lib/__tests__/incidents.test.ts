import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { prisma } from "../../test/setup.js";
import prismaDefault from "../prisma.js";
import { recordIncident, resolveIncident } from "../incidents.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "service_incidents" CASCADE');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordIncident", () => {
  it("legt einen neuen open Incident an wenn keiner existiert", async () => {
    await recordIncident("nzb-service", "store", "connection refused");

    const rows = await prisma.serviceIncident.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service: "nzb-service",
      operation: "store",
      status: "open",
      message: "connection refused",
      occurrences: 1,
      resolvedAt: null,
    });
  });

  it("dedupliziert: bumpt lastSeenAt und occurrences statt neu anzulegen", async () => {
    await recordIncident("nzb-service", "store", "fehler 1");
    const first = await prisma.serviceIncident.findFirstOrThrow();
    const firstSeen = first.firstSeenAt;
    const lastSeen1 = first.lastSeenAt;

    // kurz warten damit lastSeenAt sichtbar voranschreitet
    await new Promise((r) => setTimeout(r, 5));

    await recordIncident("nzb-service", "store", "fehler 2");

    const rows = await prisma.serviceIncident.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].occurrences).toBe(2);
    expect(rows[0].message).toBe("fehler 2");
    expect(rows[0].firstSeenAt.getTime()).toBe(firstSeen.getTime());
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(lastSeen1.getTime());
  });

  it("trennt Incidents nach (service, operation)", async () => {
    await recordIncident("nzb-service", "store", "msg-store");
    await recordIncident("nzb-service", "fetch", "msg-fetch");
    await recordIncident("other", "store", "msg-other");

    const rows = await prisma.serviceIncident.findMany();
    expect(rows).toHaveLength(3);
  });

  it("legt nach resolveIncident wieder einen neuen open Incident an", async () => {
    await recordIncident("nzb-service", "store", "erste welle");
    await resolveIncident("nzb-service", "store");
    await recordIncident("nzb-service", "store", "zweite welle");

    const rows = await prisma.serviceIncident.findMany({
      orderBy: { firstSeenAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("resolved");
    expect(rows[1].status).toBe("open");
    expect(rows[1].occurrences).toBe(1);
  });

  it("wirft nicht wenn die DB-Operation fehlschlaegt", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prismaDefault.serviceIncident, "findFirst").mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(
      recordIncident("nzb-service", "store", "boom"),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("resolveIncident", () => {
  it("setzt alle open Incidents fuer (service, operation) auf resolved", async () => {
    await recordIncident("nzb-service", "store", "fail 1");
    await recordIncident("nzb-service", "store", "fail 2"); // dedup, immer noch 1 row

    await resolveIncident("nzb-service", "store");

    const rows = await prisma.serviceIncident.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("resolved");
    expect(rows[0].resolvedAt).not.toBeNull();
  });

  it("laesst Incidents anderer (service, operation) unangetastet", async () => {
    await recordIncident("nzb-service", "store", "x");
    await recordIncident("nzb-service", "fetch", "y");

    await resolveIncident("nzb-service", "store");

    const fetchOpen = await prisma.serviceIncident.findFirst({
      where: { service: "nzb-service", operation: "fetch" },
    });
    expect(fetchOpen?.status).toBe("open");
  });

  it("ist idempotent wenn keine open Incidents existieren", async () => {
    await expect(
      resolveIncident("nzb-service", "store"),
    ).resolves.toBeUndefined();
  });

  it("wirft nicht wenn die DB-Operation fehlschlaegt", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prismaDefault.serviceIncident, "updateMany").mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(
      resolveIncident("nzb-service", "store"),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});
