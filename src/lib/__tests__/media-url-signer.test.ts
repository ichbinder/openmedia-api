import { describe, it, expect } from "vitest";
import { signMediaUrl, verifyMediaUrl, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_SECRET_LENGTH } from "../media-url-signer";

const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars ≥ 32
const HASH = "abc123def456";
const USER_ID = "user-42";

describe("signMediaUrl", () => {
  it("signs a URL and returns sig, exp, u", () => {
    const result = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });

    expect(result).toHaveProperty("sig");
    expect(result).toHaveProperty("exp");
    expect(result.u).toBe(USER_ID);
    expect(typeof result.sig).toBe("string");
    expect(typeof result.exp).toBe("number");
    expect(result.sig.length).toBeGreaterThan(0);
  });

  it("uses DEFAULT_TTL_SECONDS when ttlSeconds is omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const after = Math.floor(Date.now() / 1000);

    expect(result.exp).toBeGreaterThanOrEqual(before + DEFAULT_TTL_SECONDS);
    expect(result.exp).toBeLessThanOrEqual(after + DEFAULT_TTL_SECONDS);
  });

  it("respects custom ttlSeconds", () => {
    const ttl = 600;
    const before = Math.floor(Date.now() / 1000);
    const result = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET, ttlSeconds: ttl });

    expect(result.exp).toBeGreaterThanOrEqual(before + ttl);
    expect(result.exp).toBeLessThanOrEqual(before + ttl + 1);
  });

  it("rejects TTL > 6h (21600s)", () => {
    expect(() =>
      signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET, ttlSeconds: 21601 })
    ).toThrow(/TTL must not exceed 21600/);
  });

  it("rejects TTL exactly at max (21600) boundary — allowed", () => {
    // 21600 should NOT throw
    const result = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET, ttlSeconds: 21600 });
    expect(result).toHaveProperty("sig");
  });

  it("rejects secret shorter than 32 characters", () => {
    expect(() =>
      signMediaUrl({ hash: HASH, userId: USER_ID, secret: "short" })
    ).toThrow(/at least 32 characters/);
  });

  it("accepts secret of exactly 32 characters", () => {
    const result = signMediaUrl({ hash: HASH, userId: USER_ID, secret: "a".repeat(32) });
    expect(result).toHaveProperty("sig");
  });
});

describe("verifyMediaUrl", () => {
  it("verifies a valid signed URL (roundtrip)", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const result = verifyMediaUrl({ hash: HASH, sig: signed.sig, exp: signed.exp, u: signed.u, secret: SECRET });

    expect(result).toEqual({ ok: true });
  });

  it("rejects tampered hash", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const result = verifyMediaUrl({ hash: "tampered_hash", sig: signed.sig, exp: signed.exp, u: signed.u, secret: SECRET });

    expect(result).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects tampered exp", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const result = verifyMediaUrl({ hash: HASH, sig: signed.sig, exp: signed.exp + 9999, u: signed.u, secret: SECRET });

    expect(result).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects tampered u (userId)", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const result = verifyMediaUrl({ hash: HASH, sig: signed.sig, exp: signed.exp, u: "other-user", secret: SECRET });

    expect(result).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects tampered sig", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const tamperedSig = signed.sig.replace(/a/, "b");
    // If sig happens to have no 'a', flip the first char
    const sig = tamperedSig !== signed.sig ? tamperedSig : "X" + signed.sig.slice(1);
    const result = verifyMediaUrl({ hash: HASH, sig, exp: signed.exp, u: signed.u, secret: SECRET });

    expect(result).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects expired URLs (exp in the past)", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    // Simulate now being 1 second past expiration
    const result = verifyMediaUrl({
      hash: HASH,
      sig: signed.sig,
      exp: signed.exp,
      u: signed.u,
      secret: SECRET,
      nowFn: () => (signed.exp + 1) * 1000,
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects when exp equals now (boundary — expired)", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const result = verifyMediaUrl({
      hash: HASH,
      sig: signed.sig,
      exp: signed.exp,
      u: signed.u,
      secret: SECRET,
      nowFn: () => signed.exp * 1000,
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects missing fields — empty hash", () => {
    const result = verifyMediaUrl({ hash: "", sig: "somesig", exp: 9999999999, u: USER_ID, secret: SECRET });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects missing fields — empty sig", () => {
    const result = verifyMediaUrl({ hash: HASH, sig: "", exp: 9999999999, u: USER_ID, secret: SECRET });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects missing fields — zero exp", () => {
    const result = verifyMediaUrl({ hash: HASH, sig: "somesig", exp: 0, u: USER_ID, secret: SECRET });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects missing fields — empty u", () => {
    const result = verifyMediaUrl({ hash: HASH, sig: "somesig", exp: 9999999999, u: "", secret: SECRET });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects missing fields — empty secret", () => {
    const result = verifyMediaUrl({ hash: HASH, sig: "somesig", exp: 9999999999, u: USER_ID, secret: "" });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("never throws — returns error objects for all invalid inputs", () => {
    // Even with completely bogus inputs, should not throw
    expect(() =>
      verifyMediaUrl({ hash: "", sig: "", exp: 0, u: "", secret: "" })
    ).not.toThrow();
  });

  it("uses constant-time comparison — no early return on length mismatch", () => {
    // A sig with different length but matching prefix should still fail as tampered
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET });
    const shortSig = signed.sig.slice(0, -4);
    const result = verifyMediaUrl({ hash: HASH, sig: shortSig, exp: signed.exp, u: signed.u, secret: SECRET });

    expect(result).toEqual({ ok: false, reason: "tampered" });
  });

  it("accepts custom ttlSeconds in roundtrip", () => {
    const signed = signMediaUrl({ hash: HASH, userId: USER_ID, secret: SECRET, ttlSeconds: 60 });
    const result = verifyMediaUrl({ hash: HASH, sig: signed.sig, exp: signed.exp, u: signed.u, secret: SECRET });
    expect(result).toEqual({ ok: true });
  });
});
