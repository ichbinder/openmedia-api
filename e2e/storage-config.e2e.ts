import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

describe("Storage Endpoints (no S3 configured)", () => {
  const savedS3Vars: Record<string, string | undefined> = {};
  const s3Keys = ["S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

  beforeAll(() => {
    for (const key of s3Keys) {
      savedS3Vars[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of s3Keys) {
      if (savedS3Vars[key] !== undefined) process.env[key] = savedS3Vars[key];
    }
  });
  it("GET /storage/files returns 503 without S3 config", async () => {
    const user = await createTestUser();

    const res = await api("/storage/files", { token: user.token });
    expect(res.status).toBe(503);
  });

  it("GET /storage/usage returns 503 without S3 config", async () => {
    const user = await createTestUser();

    const res = await api("/storage/usage", { token: user.token });
    expect(res.status).toBe(503);
  });

  it("storage endpoints require authentication", async () => {
    const res = await api("/storage/files");
    expect(res.status).toBe(401);
  });
});

describe("Config Endpoints (no encryption configured)", () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  afterAll(() => {
    if (savedKey !== undefined) process.env.ENCRYPTION_MASTER_KEY = savedKey;
  });
  it("GET /config/keys returns 503 without ENCRYPTION_MASTER_KEY", async () => {
    const user = await createTestUser();

    const res = await api("/config/keys", { token: user.token });
    expect(res.status).toBe(503);
  });

  it("PUT /config/test-key returns 503 without ENCRYPTION_MASTER_KEY", async () => {
    const user = await createTestUser();

    const res = await api("/config/test-key", {
      method: "PUT",
      token: user.token,
      body: { value: "test-value" },
    });

    expect(res.status).toBe(503);
  });

  it("config endpoints require authentication", async () => {
    const res = await api("/config/keys");
    expect(res.status).toBe(401);
  });
});
