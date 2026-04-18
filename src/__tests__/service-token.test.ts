import { describe, it, expect } from "vitest";
import { prisma } from "../test/setup.js";
import {
  generateServiceToken,
  hashServiceToken,
  storeServiceToken,
  validateServiceToken,
  deleteServiceTokens,
} from "../lib/service-token.js";

describe("ServiceToken lifecycle", () => {
  it("generateServiceToken returns 64-char hex plaintext and hash", () => {
    const { plaintext, hash } = generateServiceToken();

    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plaintext).not.toBe(hash);
  });

  it("hashServiceToken is deterministic", () => {
    const h1 = hashServiceToken("test-token-abc");
    const h2 = hashServiceToken("test-token-abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("storeServiceToken persists to DB and is findable by hash", async () => {
    const { plaintext, hash } = generateServiceToken();
    const record = await storeServiceToken(hash, "job-store-test", "download");

    expect(record.tokenHash).toBe(hash);
    expect(record.jobId).toBe("job-store-test");
    expect(record.jobType).toBe("download");

    // Verify findable via Prisma
    const found = await prisma.serviceToken.findUnique({ where: { tokenHash: hash } });
    expect(found).not.toBeNull();
    expect(found!.jobId).toBe("job-store-test");
  });

  it("validateServiceToken with valid token returns record", async () => {
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, "job-validate-ok", "download");

    const result = await validateServiceToken(plaintext);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe("job-validate-ok");
    expect(result!.jobType).toBe("download");
  });

  it("validateServiceToken with invalid token returns null", async () => {
    const result = await validateServiceToken("nonexistent-token-value");
    expect(result).toBeNull();
  });

  it("deleteServiceTokens removes all tokens for a jobId", async () => {
    const t1 = generateServiceToken();
    const t2 = generateServiceToken();
    await storeServiceToken(t1.hash, "job-delete-test", "download");
    await storeServiceToken(t2.hash, "job-delete-test", "download");

    const result = await deleteServiceTokens("job-delete-test");
    expect(result.count).toBe(2);

    // Both should be gone
    const check1 = await validateServiceToken(t1.plaintext);
    const check2 = await validateServiceToken(t2.plaintext);
    expect(check1).toBeNull();
    expect(check2).toBeNull();
  });

  it("deleteServiceTokens returns count 0 for unknown jobId", async () => {
    const result = await deleteServiceTokens("nonexistent-job-id");
    expect(result.count).toBe(0);
  });
});
