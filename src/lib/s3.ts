/**
 * S3 Storage Service — wraps all S3 operations for Hetzner Object Storage.
 *
 * Configuration via environment variables:
 *   S3_ACCESS_KEY — Hetzner S3 access key
 *   S3_SECRET_KEY — Hetzner S3 secret key
 *   S3_ENDPOINT   — S3 endpoint (e.g. https://hel1.your-objectstorage.com)
 *   S3_BUCKET     — Bucket name (e.g. openmedia-files)
 *   S3_REGION     — Region (e.g. hel1)
 *
 * All files are stored with hash-based keys: {hash}/{hash}.ext
 * No movie names or TMDB IDs in storage — only the DB knows the mapping.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getConfig() {
  return {
    accessKey: process.env.S3_ACCESS_KEY || "",
    secretKey: process.env.S3_SECRET_KEY || "",
    endpoint: process.env.S3_ENDPOINT || "",
    bucket: process.env.S3_BUCKET || "",
    region: process.env.S3_REGION || "hel1",
  };
}

/** Check if S3 is configured by reading raw env vars (no fallback defaults). */
export function isS3Configured(): boolean {
  return !!(
    process.env.S3_ACCESS_KEY &&
    process.env.S3_SECRET_KEY &&
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET
  );
}

// ---------------------------------------------------------------------------
// Client (lazy singleton — rebuilt if env changes during tests)
// ---------------------------------------------------------------------------

let _client: S3Client | null = null;
let _clientConfigHash = "";

function getClient(): S3Client {
  const cfg = getConfig();
  const configHash = `${cfg.accessKey}:${cfg.secretKey}:${cfg.endpoint}:${cfg.region}`;

  if (_client && _clientConfigHash === configHash) {
    return _client;
  }

  const clientConfig: S3ClientConfig = {
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
  };

  _client = new S3Client(clientConfig);
  _clientConfigHash = configHash;
  return _client;
}

function getBucket(): string {
  return getConfig().bucket;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface S3FileMetadata {
  key: string;
  size: number;
  lastModified: Date | undefined;
  contentType: string | undefined;
  etag: string | undefined;
}

export interface S3ListResult {
  files: Array<{
    key: string;
    size: number;
    lastModified: Date | undefined;
  }>;
  truncated: boolean;
  nextToken: string | undefined;
}

export interface S3UploadResult {
  key: string;
  bucket: string;
  etag: string | undefined;
}

// ---------------------------------------------------------------------------
// Max presigned URL expiry — Hetzner S3 supports up to 7 days
// ---------------------------------------------------------------------------

export const MAX_PRESIGNED_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

export const EXPIRY_PRESETS: Record<string, number> = {
  "1h": 60 * 60,
  "1d": 24 * 60 * 60,
  "3d": 3 * 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Upload a file to S3.
 *
 * @param key     S3 object key (e.g. "{hash}/{hash}.mkv")
 * @param body    File content as Buffer, Uint8Array, string, or Readable stream
 * @param contentType  MIME type (e.g. "video/x-matroska")
 */
export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array | string | Readable,
  contentType?: string,
): Promise<S3UploadResult> {
  const start = Date.now();
  const bucket = getBucket();

  try {
    const result = await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    const durationMs = Date.now() - start;
    console.log(`[s3] Upload: ${key} → ${bucket} (${durationMs}ms)`);

    return {
      key,
      bucket,
      etag: result.ETag,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    console.error(`[s3] Upload failed: ${key} → ${bucket} (${durationMs}ms) — ${err.Code || err.name}: ${err.message}`);
    throw err;
  }
}

/**
 * Delete a file from S3.
 */
export async function deleteFile(key: string): Promise<void> {
  const start = Date.now();
  const bucket = getBucket();

  try {
    await getClient().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    const durationMs = Date.now() - start;
    console.log(`[s3] Delete: ${key} from ${bucket} (${durationMs}ms)`);
  } catch (err: any) {
    const durationMs = Date.now() - start;
    console.error(`[s3] Delete failed: ${key} from ${bucket} (${durationMs}ms) — ${err.Code || err.name}: ${err.message}`);
    throw err;
  }
}

/**
 * Generate a presigned download URL.
 *
 * @param key        S3 object key
 * @param expiresIn  Expiry in seconds (default 7 days, max 7 days)
 * @returns          Presigned URL string
 */
export async function generatePresignedUrl(
  key: string,
  expiresIn: number = MAX_PRESIGNED_EXPIRY_SECONDS,
): Promise<string> {
  const effectiveExpiry = Math.min(expiresIn, MAX_PRESIGNED_EXPIRY_SECONDS);

  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
    { expiresIn: effectiveExpiry },
  );

  console.log(`[s3] Presigned URL: ${key} (expires in ${effectiveExpiry}s)`);
  return url;
}

/**
 * Generate a presigned upload URL (for direct client-to-S3 uploads).
 *
 * @param key          S3 object key
 * @param contentType  Expected MIME type
 * @param expiresIn    Expiry in seconds (default 1 hour)
 * @returns            Presigned URL string
 */
export async function generatePresignedUploadUrl(
  key: string,
  contentType?: string,
  expiresIn: number = 3600,
): Promise<string> {
  const effectiveExpiry = Math.min(expiresIn, MAX_PRESIGNED_EXPIRY_SECONDS);

  const url = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: effectiveExpiry },
  );

  console.log(`[s3] Presigned upload URL: ${key} (expires in ${effectiveExpiry}s)`);
  return url;
}

/**
 * List files in S3 with optional prefix filter.
 *
 * @param prefix       Key prefix to filter (e.g. "{hash}/")
 * @param maxKeys      Max results (default 100)
 * @param startAfter   Pagination token from previous response
 */
export async function listFiles(
  prefix?: string,
  maxKeys: number = 100,
  continuationToken?: string,
): Promise<S3ListResult> {
  const result = await getClient().send(
    new ListObjectsV2Command({
      Bucket: getBucket(),
      Prefix: prefix,
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken,
    }),
  );

  return {
    files: (result.Contents || []).map((obj) => ({
      key: obj.Key || "",
      size: obj.Size || 0,
      lastModified: obj.LastModified,
    })),
    truncated: result.IsTruncated || false,
    nextToken: result.NextContinuationToken,
  };
}

/**
 * Get metadata for a single file (HEAD request — no data transfer).
 */
export async function getFileMetadata(key: string, bucket?: string): Promise<S3FileMetadata> {
  const result = await getClient().send(
    new HeadObjectCommand({
      Bucket: bucket || getBucket(),
      Key: key,
    }),
  );

  return {
    key,
    size: result.ContentLength || 0,
    lastModified: result.LastModified,
    contentType: result.ContentType,
    etag: result.ETag,
  };
}

/**
 * Check if a file exists in S3.
 */
export async function fileExists(key: string, bucket?: string): Promise<boolean> {
  try {
    await getFileMetadata(key, bucket);
    return true;
  } catch (err: any) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}
