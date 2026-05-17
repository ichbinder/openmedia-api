import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Request, type Response, type NextFunction } from "express";
import { requirePluginToken, type PluginAuthRequest } from "../plugin-auth.js";
import { hashToken, generateApiToken } from "../../lib/api-token.js";

// Mock prisma
vi.mock("../../lib/prisma.js", () => ({
  default: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import prisma from "../../lib/prisma.js";

const mockFindUnique = prisma.apiToken.findUnique as ReturnType<typeof vi.fn>;

function makeReq(opts: { authorization?: string } = {}): PluginAuthRequest {
  return {
    headers: {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    },
  } as unknown as PluginAuthRequest;
}

function makeRes(): { res: Response; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, json, status };
}

function makeNext(): NextFunction & { called: boolean } {
  const next = vi.fn() as unknown as NextFunction & { called: boolean };
  return next;
}

const VALID_PLUGIN_TOKEN = generateApiToken();

const VALID_PLUGIN_TOKEN_ROW = {
  id: "token-uuid-1",
  userId: "user-uuid-1",
  tokenPrefix: VALID_PLUGIN_TOKEN.prefix,
  purpose: "jellyfin-plugin",
  revokedAt: null,
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
};

describe("requirePluginToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing", () => {
    const req = makeReq();
    const { res, status, json } = makeRes();
    const next = makeNext();

    requirePluginToken(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Authorization header fehlt." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is not an om_ token", () => {
    const req = makeReq({ authorization: "Bearer some-jwt-token" });
    const { res, status, json } = makeRes();
    const next = makeNext();

    requirePluginToken(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Ungültiger Token-Typ." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is not found in DB", async () => {
    const req = makeReq({ authorization: `Bearer ${VALID_PLUGIN_TOKEN.plaintext}` });
    const { res, status, json } = makeRes();
    const next = makeNext();

    mockFindUnique.mockResolvedValueOnce(null);

    requirePluginToken(req, res, next);

    // Wait for async
    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledWith(401);
    });
    expect(json).toHaveBeenCalledWith({ error: "Token nicht gefunden." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token has wrong purpose (regular user token)", async () => {
    const req = makeReq({ authorization: `Bearer ${VALID_PLUGIN_TOKEN.plaintext}` });
    const { res, status, json } = makeRes();
    const next = makeNext();

    mockFindUnique.mockResolvedValueOnce({
      ...VALID_PLUGIN_TOKEN_ROW,
      purpose: null, // regular user token has null purpose
    });

    requirePluginToken(req, res, next);

    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledWith(401);
    });
    expect(json).toHaveBeenCalledWith({ error: "Token nicht für Plugin-Zugriff freigegeben." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is revoked", async () => {
    const req = makeReq({ authorization: `Bearer ${VALID_PLUGIN_TOKEN.plaintext}` });
    const { res, status, json } = makeRes();
    const next = makeNext();

    mockFindUnique.mockResolvedValueOnce({
      ...VALID_PLUGIN_TOKEN_ROW,
      revokedAt: new Date("2024-01-01"),
    });

    requirePluginToken(req, res, next);

    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledWith(401);
    });
    expect(json).toHaveBeenCalledWith({ error: "Token wurde widerrufen." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is expired", async () => {
    const req = makeReq({ authorization: `Bearer ${VALID_PLUGIN_TOKEN.plaintext}` });
    const { res, status, json } = makeRes();
    const next = makeNext();

    mockFindUnique.mockResolvedValueOnce({
      ...VALID_PLUGIN_TOKEN_ROW,
      expiresAt: new Date("2020-01-01"),
    });

    requirePluginToken(req, res, next);

    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledWith(401);
    });
    expect(json).toHaveBeenCalledWith({ error: "Token ist abgelaufen." });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and sets req.pluginUser for valid plugin token", async () => {
    const req = makeReq({ authorization: `Bearer ${VALID_PLUGIN_TOKEN.plaintext}` });
    const { res } = makeRes();
    const next = makeNext();

    mockFindUnique.mockResolvedValueOnce(VALID_PLUGIN_TOKEN_ROW);

    requirePluginToken(req, res, next);

    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    expect(req.pluginUser).toEqual({
      userId: VALID_PLUGIN_TOKEN_ROW.userId,
      tokenId: VALID_PLUGIN_TOKEN_ROW.id,
    });
  });

  it("touches lastUsedAt on successful auth", async () => {
    const req = makeReq({ authorization: `Bearer ${VALID_PLUGIN_TOKEN.plaintext}` });
    const { res } = makeRes();
    const next = makeNext();

    mockFindUnique.mockResolvedValueOnce(VALID_PLUGIN_TOKEN_ROW);

    requirePluginToken(req, res, next);

    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    // lastUsedAt update is fire-and-forget
    expect(prisma.apiToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_PLUGIN_TOKEN_ROW.id },
        data: { lastUsedAt: expect.any(Date) },
      }),
    );
  });
});
