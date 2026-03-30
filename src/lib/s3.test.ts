import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  isS3Configured,
  uploadFile,
  deleteFile,
  generatePresignedUrl,
  listFiles,
  getFileMetadata,
  fileExists,
} from "../lib/s3.js";

/**
 * S3 Integration Tests — run against real Hetzner Object Storage.
 *
 * These tests require S3_ACCESS_KEY, S3_SECRET_KEY, S3_ENDPOINT, S3_BUCKET
 * to be set. They are automatically skipped in CI or when credentials are missing.
 *
 * All test files use prefix "test-integration/" and are cleaned up in afterAll.
 */

const TEST_PREFIX = "test-integration/";
const TEST_KEY = `${TEST_PREFIX}test-file-${Date.now()}.txt`;
const TEST_CONTENT = `S3 integration test — ${new Date().toISOString()}`;

// Skip entire suite if S3 is not configured
const runTests = isS3Configured();

describe.skipIf(!runTests)("S3 Service (integration)", () => {
  // Track keys created during tests for cleanup
  const createdKeys: string[] = [];

  afterAll(async () => {
    // Clean up all test files
    for (const key of createdKeys) {
      try {
        await deleteFile(key);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("uploads a file and verifies it exists", async () => {
    const result = await uploadFile(TEST_KEY, TEST_CONTENT, "text/plain");
    createdKeys.push(TEST_KEY);

    expect(result.key).toBe(TEST_KEY);
    expect(result.bucket).toBe(process.env.S3_BUCKET);
    expect(result.etag).toBeDefined();

    // Verify with HEAD request
    const exists = await fileExists(TEST_KEY);
    expect(exists).toBe(true);
  });

  it("gets file metadata", async () => {
    const meta = await getFileMetadata(TEST_KEY);

    expect(meta.key).toBe(TEST_KEY);
    expect(meta.size).toBe(Buffer.byteLength(TEST_CONTENT));
    expect(meta.contentType).toBe("text/plain");
    expect(meta.lastModified).toBeInstanceOf(Date);
    expect(meta.etag).toBeDefined();
  });

  it("generates a presigned download URL that works", async () => {
    const url = await generatePresignedUrl(TEST_KEY, 3600);

    expect(url).toContain("openmedia-files");
    expect(url).toContain("test-integration/");

    // Actually fetch via the presigned URL
    const res = await fetch(url);
    expect(res.ok).toBe(true);

    const body = await res.text();
    expect(body).toBe(TEST_CONTENT);
  });

  it("lists files with prefix filter", async () => {
    const result = await listFiles(TEST_PREFIX);

    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const found = result.files.find((f) => f.key === TEST_KEY);
    expect(found).toBeDefined();
    expect(found!.size).toBe(Buffer.byteLength(TEST_CONTENT));
  });

  it("reports non-existent file correctly", async () => {
    const exists = await fileExists(`${TEST_PREFIX}does-not-exist-${Date.now()}.txt`);
    expect(exists).toBe(false);
  });

  it("deletes a file", async () => {
    // Upload a separate file to delete
    const deleteKey = `${TEST_PREFIX}delete-me-${Date.now()}.txt`;
    await uploadFile(deleteKey, "delete me", "text/plain");

    // Verify it exists
    const beforeDelete = await fileExists(deleteKey);
    expect(beforeDelete).toBe(true);

    // Delete it
    await deleteFile(deleteKey);

    // Verify it's gone
    const afterDelete = await fileExists(deleteKey);
    expect(afterDelete).toBe(false);

    // Remove from cleanup list since it's already deleted
    const idx = createdKeys.indexOf(deleteKey);
    if (idx !== -1) createdKeys.splice(idx, 1);
  });

  it("uploads a Buffer", async () => {
    const bufferKey = `${TEST_PREFIX}buffer-test-${Date.now()}.bin`;
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    createdKeys.push(bufferKey);

    const result = await uploadFile(bufferKey, buffer, "application/octet-stream");
    expect(result.key).toBe(bufferKey);

    const meta = await getFileMetadata(bufferKey);
    expect(meta.size).toBe(5);
  });
});
