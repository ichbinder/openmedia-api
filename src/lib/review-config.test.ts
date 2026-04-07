import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getReviewRetentionDays,
  computeReviewExpiresAt,
  computeInitialTmdbRetryAfter,
} from "./review-config.js";

describe("review-config", () => {
  const originalEnv = process.env.REVIEW_RETENTION_DAYS;

  beforeEach(() => {
    delete process.env.REVIEW_RETENTION_DAYS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REVIEW_RETENTION_DAYS = originalEnv;
    } else {
      delete process.env.REVIEW_RETENTION_DAYS;
    }
  });

  describe("getReviewRetentionDays", () => {
    it("returns default (3) when env var is missing", () => {
      expect(getReviewRetentionDays()).toBe(3);
    });

    it("returns default when env var is empty string", () => {
      process.env.REVIEW_RETENTION_DAYS = "";
      expect(getReviewRetentionDays()).toBe(3);
    });

    it("parses valid integer strings", () => {
      process.env.REVIEW_RETENTION_DAYS = "7";
      expect(getReviewRetentionDays()).toBe(7);
    });

    it("clamps values below minimum", () => {
      process.env.REVIEW_RETENTION_DAYS = "0";
      expect(getReviewRetentionDays()).toBe(3); // 0 fails the > 0 check → default
    });

    it("clamps values above maximum", () => {
      process.env.REVIEW_RETENTION_DAYS = "365";
      expect(getReviewRetentionDays()).toBe(90);
    });

    it("rejects strings with trailing text", () => {
      process.env.REVIEW_RETENTION_DAYS = "3days";
      expect(getReviewRetentionDays()).toBe(3); // default, NOT parsed as 3
    });

    it("rejects scientific notation", () => {
      process.env.REVIEW_RETENTION_DAYS = "1e2";
      expect(getReviewRetentionDays()).toBe(3); // default, NOT parsed as 1
    });

    it("rejects floating point", () => {
      process.env.REVIEW_RETENTION_DAYS = "3.5";
      expect(getReviewRetentionDays()).toBe(3); // default, NOT parsed as 3
    });

    it("rejects leading/trailing whitespace", () => {
      process.env.REVIEW_RETENTION_DAYS = " 5 ";
      expect(getReviewRetentionDays()).toBe(3); // default, NOT parsed as 5
    });

    it("rejects negative values", () => {
      process.env.REVIEW_RETENTION_DAYS = "-1";
      expect(getReviewRetentionDays()).toBe(3); // default, regex only matches digits
    });

    it("accepts the minimum allowed value", () => {
      process.env.REVIEW_RETENTION_DAYS = "1";
      expect(getReviewRetentionDays()).toBe(1);
    });

    it("accepts the maximum allowed value", () => {
      process.env.REVIEW_RETENTION_DAYS = "90";
      expect(getReviewRetentionDays()).toBe(90);
    });
  });

  describe("computeReviewExpiresAt", () => {
    it("adds the retention window to the given 'now'", () => {
      process.env.REVIEW_RETENTION_DAYS = "3";
      const now = new Date("2026-01-01T00:00:00Z");
      const expected = new Date("2026-01-04T00:00:00Z");
      expect(computeReviewExpiresAt(now).getTime()).toBe(expected.getTime());
    });

    it("honours the configured retention", () => {
      process.env.REVIEW_RETENTION_DAYS = "7";
      const now = new Date("2026-01-01T00:00:00Z");
      const expected = new Date("2026-01-08T00:00:00Z");
      expect(computeReviewExpiresAt(now).getTime()).toBe(expected.getTime());
    });
  });

  describe("computeInitialTmdbRetryAfter", () => {
    it("returns a timestamp in the future", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const after = computeInitialTmdbRetryAfter(now);
      expect(after.getTime()).toBeGreaterThan(now.getTime());
    });

    it("is exactly 60 seconds after now by default", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const after = computeInitialTmdbRetryAfter(now);
      expect(after.getTime() - now.getTime()).toBe(60 * 1000);
    });
  });
});
